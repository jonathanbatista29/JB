'use strict';
const { EventEmitter } = require('events');

// Rastreabilidade: quando o PLC liga um bit (gatilho), a IHM grava uma linha no banco com
// o código da peça (ex.: RFID), os valores escolhidos, o resultado OK/NOK e o operador logado.
// Depois de gravar, liga o bit de confirmação; quando o PLC desliga o gatilho, a IHM desliga
// a confirmação (handshake). Se não der para gravar (ex.: tag sem comunicação), não confirma e
// tenta de novo enquanto o gatilho estiver ligado — assim nenhuma peça passa sem registro.
//
// Os registros ficam na tabela trace_records do banco de histórico do projeto (historico.db),
// por isso entram no backup, no download e na restauração do histórico.
const RETRY_MS = 2000;
const PULSE_MS = 1000;
const DAY = 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS trace_records (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, def TEXT NOT NULL, code TEXT, result INTEGER, user TEXT, data TEXT);
  CREATE INDEX IF NOT EXISTS trace_ts ON trace_records (ts);
  CREATE INDEX IF NOT EXISTS trace_code ON trace_records (code);
  CREATE INDEX IF NOT EXISTS trace_def ON trace_records (def, ts);
`;

const isOn = (v) => v === true || (typeof v === 'number' && v !== 0) || v === 'true' || v === '1';

// Configuração normalizada (project.trace = { keepDays, defs: [...] }).
function normalizeTrace(t = {}) {
  const keep = Math.round(Number(t.keepDays));
  return {
    keepDays: Number.isFinite(keep) && keep > 0 ? Math.min(36500, keep) : 0,
    defs: (Array.isArray(t.defs) ? t.defs : []).filter((d) => d && d.id).map((d) => ({
      id: String(d.id), name: String(d.name || ''), enabled: d.enabled !== false,
      trigger: String(d.trigger || ''), trigMode: d.trigMode === 'change' ? 'change' : 'rising',
      keyTag: String(d.keyTag || ''),
      fields: (Array.isArray(d.fields) ? d.fields : []).filter((f) => f && f.tag).map((f) => ({ tag: String(f.tag), label: String(f.label || '') })),
      resultTag: String(d.resultTag || ''), okValue: d.okValue === '' || d.okValue == null ? '' : Number(d.okValue),
      ackTag: String(d.ackTag || ''), resetTrigger: Boolean(d.resetTrigger),
    })),
  };
}

class Traceability extends EventEmitter {
  // getDb: banco atual do histórico (muda quando o histórico é restaurado)
  // getUsers: usuários logados nos painéis do projeto (para gravar o operador)
  constructor(tm, getDb, getUsers = () => []) {
    super();
    this.tm = tm;
    this.getDb = getDb;
    this.getUsers = getUsers;
    this.cfg = normalizeTrace();
    this.st = new Map(); // id -> { prev, done, pending, retry, busy, count, lastTs, lastCode, lastResult, error }
    this.dbReady = new WeakSet();
    this.cleanTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  db() {
    const db = this.getDb();
    if (!this.dbReady.has(db)) { db.exec(SCHEMA); this.dbReady.add(db); }
    return db;
  }

  configure(project) {
    this.project = project;
    this.cfg = normalizeTrace(project.trace);
    const ids = new Set(this.cfg.defs.map((d) => d.id));
    for (const [k, s] of this.st) if (!ids.has(k)) { clearTimeout(s.retry); this.st.delete(k); }
    for (const d of this.cfg.defs) if (!this.st.has(d.id)) this.st.set(d.id, { count: 0 });
    // Gatilho que já estava ligado (ex.: IHM reiniciou com uma peça esperando): avalia agora.
    setTimeout(() => { for (const d of this.cfg.defs) this.check(d); }, 300);
    this.cleanup();
    this.publish();
  }

  onValues(changed) {
    for (const d of this.cfg.defs) if (changed[d.trigger]) this.check(d);
  }

  check(d) {
    const s = this.st.get(d.id);
    if (!s || d.enabled === false || !d.trigger) return;
    const val = this.tm.values[d.trigger];
    if (!val || val.q !== 'good') return;
    if (d.trigMode === 'change') {
      // Grava quando o valor muda (ex.: código novo ou passo da máquina). Zero/vazio não grava.
      const v = val.v;
      if (s.prev === undefined) { s.prev = v; return; } // primeiro valor lido: só memoriza
      if (v === s.prev) return;
      s.prev = v;
      if (v === 0 || v === '' || v === false || v == null) return;
      this.request(d, s);
      return;
    }
    const on = isOn(val.v);
    const was = s.prev;
    s.prev = on;
    if (!on) {
      // PLC desligou o gatilho: desliga a confirmação e libera para a próxima peça.
      clearTimeout(s.retry);
      s.pending = false;
      if (s.done && d.ackTag && !d.resetTrigger) this.writeSafe(d, s, d.ackTag, false);
      s.done = false;
      this.publish();
      return;
    }
    if (was === true || s.done || s.pending) return;
    // Ligado na partida da IHM: se a confirmação já está ligada, essa peça já foi gravada.
    if (was === undefined && d.ackTag && isOn(this.tm.values[d.ackTag]?.v)) { s.done = true; return; }
    this.request(d, s);
  }

  request(d, s) {
    s.pending = true;
    this.attempt(d, s);
  }

  async attempt(d, s) {
    clearTimeout(s.retry);
    if (!s.pending || s.busy || !this.st.has(d.id)) return;
    s.busy = true;
    try {
      const rec = this.capture(d);
      const r = this.db().prepare('INSERT INTO trace_records (ts, def, code, result, user, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rec.ts, d.id, rec.code, rec.result, rec.user, JSON.stringify(rec.data));
      rec.id = Number(r.lastInsertRowid);
      s.pending = false;
      s.done = true;
      s.count = (s.count || 0) + 1;
      s.lastTs = rec.ts; s.lastCode = rec.code; s.lastResult = rec.result;
      s.error = null;
      this.emit('record', { ...rec, def: d.id, defName: d.name });
      if (d.ackTag) {
        await this.writeSafe(d, s, d.ackTag, true);
        // Sem o PLC desligar o gatilho (modo "mudou" ou a IHM desliga o gatilho), a confirmação é um pulso.
        if (d.trigMode === 'change' || d.resetTrigger) setTimeout(() => this.writeSafe(d, s, d.ackTag, false), PULSE_MS);
      }
      if (d.resetTrigger && d.trigMode === 'rising') await this.writeSafe(d, s, d.trigger, false);
    } catch (e) {
      s.error = e.message;
      s.errorTs = Date.now();
      // Tenta de novo enquanto o gatilho continuar ligado (no modo "mudou", até o próximo valor).
      s.retry = setTimeout(() => this.attempt(d, s), RETRY_MS);
    } finally {
      s.busy = false;
      this.publish();
    }
  }

  // Lê o código, os dados e o resultado no instante do gatilho. Tag sem comunicação = não grava.
  capture(d) {
    const v = this.tm.values;
    const bad = [];
    const get = (tag) => {
      const x = v[tag];
      if (!this.project.tags.some((t) => t.name === tag)) { bad.push(`${tag} (não existe)`); return null; }
      if (!x || x.q !== 'good') { bad.push(tag); return null; }
      return x.v;
    };
    const code = d.keyTag ? get(d.keyTag) : null;
    const data = {};
    for (const f of d.fields) data[f.tag] = get(f.tag);
    let result = null;
    if (d.resultTag) {
      const r = get(d.resultTag);
      if (r != null) result = d.okValue === '' ? (isOn(r) ? 1 : 0) : (Number(r) === Number(d.okValue) ? 1 : 0);
    }
    if (bad.length) throw new Error(`Sem leitura: ${bad.join(', ')}`);
    if (d.keyTag && (code === '' || code == null)) throw new Error('Código da peça vazio');
    return { ts: Date.now(), code: code == null ? '' : String(code), result, user: [...new Set(this.getUsers().filter(Boolean))].join(', '), data };
  }

  async writeSafe(d, s, tag, value) {
    try {
      await this.tm.write(tag, value);
    } catch (e) {
      s.error = `Não foi possível escrever ${tag}: ${e.message}`;
      s.errorTs = Date.now();
      this.publish();
    }
  }

  // ---------- Consulta ----------
  where(q = {}) {
    const w = [], a = [];
    if (q.def) { w.push('def = ?'); a.push(String(q.def)); }
    if (q.code) { w.push("code LIKE ? ESCAPE '\\'"); a.push('%' + String(q.code).replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
    if (Number(q.from)) { w.push('ts >= ?'); a.push(Number(q.from)); }
    if (Number(q.to)) { w.push('ts <= ?'); a.push(Number(q.to)); }
    if (q.result === 'ok') w.push('result = 1');
    if (q.result === 'nok') w.push('result = 0');
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
  }

  search(q = {}) {
    const { sql, args } = this.where(q);
    const limit = Math.min(5000, Math.max(1, Number(q.limit) || 200));
    const offset = Math.max(0, Number(q.offset) || 0);
    const db = this.db();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM trace_records ${sql}`).get(...args).n;
    const rows = db.prepare(`SELECT id, ts, def, code, result, user, data FROM trace_records ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(parseRow);
    return { total, rows };
  }

  // Todas as linhas do filtro (para exportar), da mais antiga para a mais nova.
  *iterate(q = {}) {
    const { sql, args } = this.where(q);
    for (const r of this.db().prepare(`SELECT id, ts, def, code, result, user, data FROM trace_records ${sql} ORDER BY ts, id LIMIT 200000`).iterate(...args)) yield parseRow(r);
  }

  cleanup() {
    if (!this.cfg.keepDays) return;
    try { this.db().prepare('DELETE FROM trace_records WHERE ts < ?').run(Date.now() - this.cfg.keepDays * DAY); } catch {}
  }

  state() {
    return this.cfg.defs.map((d) => {
      const s = this.st.get(d.id) || {};
      return { id: d.id, count: s.count || 0, lastTs: s.lastTs || null, lastCode: s.lastCode ?? null, lastResult: s.lastResult ?? null,
        waiting: Boolean(s.pending), error: s.error || null, errorTs: s.errorTs || null };
    });
  }

  publish() {
    clearTimeout(this.pubTimer);
    this.pubTimer = setTimeout(() => this.emit('state', this.state()), 150);
  }

  stop() {
    clearInterval(this.cleanTimer);
    clearTimeout(this.pubTimer);
    for (const s of this.st.values()) clearTimeout(s.retry);
  }
}

function parseRow(r) {
  let data = {};
  try { data = JSON.parse(r.data || '{}'); } catch {}
  return { id: r.id, ts: r.ts, def: r.def, code: r.code, result: r.result, user: r.user, data };
}

module.exports = { Traceability, normalizeTrace };
