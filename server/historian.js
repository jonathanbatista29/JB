'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Histórico em banco de dados SQLite (um arquivo por projeto):
//  - valores dos tags marcados para registro (por mudança, com banda morta e intervalo mínimo, e periódico)
//  - resumo por minuto (média, mínimo e máximo) para guardar períodos longos ocupando pouco
//  - eventos de alarme e registro de ações
//
// Como o espaço é controlado:
//  - dados completos ficam `rawDays` dias; depois disso só o resumo por minuto, por `summaryDays` dias
//  - tabelas organizadas pela chave (tag, horário), sem índices extras (~23 bytes por registro)
//  - limite opcional de tamanho (`maxSizeMB`): apaga primeiro os dados mais antigos
//  - o espaço apagado volta para o disco aos poucos (auto_vacuum incremental), sem travar o servidor
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'historico.db');
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const MAINT_MS = 5 * MIN;

const DEFAULTS = { rawDays: 14, summaryDays: 365, heartbeatSec: 60, maxSizeMB: 0 };

// Normaliza a configuração do histórico (aceita o formato antigo com retentionDays).
function normalizeConfig(h = {}) {
  const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };
  const rawDays = num(h.rawDays, h.retentionDays != null ? Math.min(DEFAULTS.rawDays, Number(h.retentionDays) || DEFAULTS.rawDays) : DEFAULTS.rawDays, 1, 3650);
  const summaryDefault = h.retentionDays != null ? Math.max(DEFAULTS.summaryDays, Number(h.retentionDays) || 0) : DEFAULTS.summaryDays;
  const summaryDays = Math.max(rawDays, num(h.summaryDays, summaryDefault, 1, 3650));
  return { rawDays, summaryDays, heartbeatSec: num(h.heartbeatSec, DEFAULTS.heartbeatSec, 1, 3600), maxSizeMB: num(h.maxSizeMB, 0, 0, 10 * 1024 * 1024) };
}

class Historian {
  constructor(file = DB_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    const old = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'samples'").get();
    // Banco novo: auto_vacuum precisa ser definido antes de criar as tabelas.
    if (!old) this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    if (old && !/WITHOUT ROWID/i.test(old.sql)) this.migrateV1();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tag_names (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS samples (tag_id INTEGER NOT NULL, ts INTEGER NOT NULL, v REAL, q INTEGER NOT NULL, PRIMARY KEY (tag_id, ts)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS samples_min (tag_id INTEGER NOT NULL, ts INTEGER NOT NULL, a REAL, mn REAL, mx REAL, n INTEGER NOT NULL, PRIMARY KEY (tag_id, ts)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS alarm_events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT, message TEXT, tag TEXT, value TEXT, priority TEXT, user TEXT);
      CREATE INDEX IF NOT EXISTS alarm_ts ON alarm_events (ts);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT, action TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
    `);
    this.st = {
      tagId: this.db.prepare('SELECT id FROM tag_names WHERE name = ?'),
      tagIns: this.db.prepare('INSERT INTO tag_names (name) VALUES (?)'),
      tagAll: this.db.prepare('SELECT id, name FROM tag_names'),
      sample: this.db.prepare('INSERT OR REPLACE INTO samples (tag_id, ts, v, q) VALUES (?, ?, ?, ?)'),
      rawFirst: this.db.prepare('SELECT MIN(ts) AS t FROM samples WHERE tag_id = ?'),
      rollup: this.db.prepare(`INSERT OR REPLACE INTO samples_min (tag_id, ts, a, mn, mx, n)
        SELECT tag_id, (ts / 60000) * 60000 AS m, AVG(v), MIN(v), MAX(v), COUNT(v) FROM samples
        WHERE tag_id = ? AND ts >= ? AND ts < ? GROUP BY m`),
      delRaw: this.db.prepare('DELETE FROM samples WHERE tag_id = ? AND ts < ?'),
      delSum: this.db.prepare('DELETE FROM samples_min WHERE tag_id = ? AND ts < ?'),
      sumFirst: this.db.prepare('SELECT MIN(ts) AS t FROM samples_min WHERE tag_id = ?'),
      metaGet: this.db.prepare('SELECT v FROM meta WHERE k = ?'),
      metaSet: this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)'),
      alarm: this.db.prepare('INSERT INTO alarm_events (ts, event, message, tag, value, priority, user) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      audit: this.db.prepare('INSERT INTO audit (ts, user, action, detail) VALUES (?, ?, ?, ?)'),
    };
    this.ids = new Map();
    this.cfg = normalizeConfig();
    this.logged = new Map(); // tag -> { deadband, minMs }
    this.last = new Map();   // tag -> { v, q, ts } último valor gravado
    this.current = new Map(); // tag -> { v, q } valor atual
    this.pending = new Map(); // tag -> valor que esperou o intervalo mínimo
    this.buf = [];
    this.lastTrim = null;
    this.flushTimer = setInterval(() => this.flush(), 1000);
    this.beatTimer = setInterval(() => this.heartbeat(), 1000);
    this.maintTimer = setInterval(() => this.maintenance(), MAINT_MS);
    this.firstMaint = setTimeout(() => this.maintenance(), 10000);
  }

  // Converte o formato antigo (uma tabela com dois índices) para o compacto. Roda uma vez.
  migrateV1() {
    const t0 = Date.now();
    console.log(`Histórico: convertendo ${path.basename(path.dirname(this.file))}/${path.basename(this.file)} para o formato compacto...`);
    this.db.exec(`BEGIN;
      ALTER TABLE samples RENAME TO samples_v1;
      CREATE TABLE samples (tag_id INTEGER NOT NULL, ts INTEGER NOT NULL, v REAL, q INTEGER NOT NULL, PRIMARY KEY (tag_id, ts)) WITHOUT ROWID;
      INSERT OR REPLACE INTO samples (tag_id, ts, v, q) SELECT tag_id, ts, v, q FROM samples_v1 ORDER BY tag_id, ts;
      DROP TABLE samples_v1;
      COMMIT;`);
    // Liga a devolução de espaço ao disco e reorganiza o arquivo (precisa de VACUUM uma vez).
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
    console.log(`Histórico: conversão concluída em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  // Aplica a configuração do projeto: quais tags registrar e por quanto tempo guardar.
  configure(project) {
    this.cfg = normalizeConfig(project.historian || {});
    this.logged = new Map();
    for (const t of project.tags || []) {
      if (t.log && t.type !== 'string') {
        this.logged.set(t.name, { deadband: Math.abs(Number(t.logDeadband) || 0), minMs: Math.max(0, Number(t.logMinSec) || 0) * 1000 });
      }
    }
    for (const k of [...this.last.keys()]) if (!this.logged.has(k)) this.last.delete(k);
    for (const k of [...this.pending.keys()]) if (!this.logged.has(k)) this.pending.delete(k);
  }

  tagId(name) {
    let id = this.ids.get(name);
    if (id) return id;
    const row = this.st.tagId.get(name);
    id = row ? row.id : Number(this.st.tagIns.run(name).lastInsertRowid);
    this.ids.set(name, id);
    return id;
  }

  // Recebe os valores alterados vindos dos PLCs.
  onValues(changed) {
    for (const [name, val] of Object.entries(changed)) {
      const v = toNumber(val.v);
      const q = val.q === 'good' ? 1 : 0;
      this.current.set(name, { v, q });
      const cfg = this.logged.get(name);
      if (!cfg) continue;
      const prev = this.last.get(name);
      const significant = !prev || prev.q !== q || (q && (prev.v == null || v == null || Math.abs(v - prev.v) > cfg.deadband));
      if (!significant) { this.pending.delete(name); continue; }
      const ts = val.ts || Date.now();
      // Intervalo mínimo: guarda o valor mais novo e grava quando o intervalo passar.
      if (cfg.minMs && prev && prev.q === q && ts - prev.ts < cfg.minMs) { this.pending.set(name, { v, q }); continue; }
      this.pending.delete(name);
      this.push(name, ts, v, q);
    }
  }

  // A cada segundo: grava valores que esperavam o intervalo mínimo e, sem mudança, grava periodicamente.
  heartbeat() {
    const ms = Math.max(1, Number(this.cfg.heartbeatSec) || 60) * 1000;
    const now = Date.now();
    for (const [name, p] of this.pending) {
      const cfg = this.logged.get(name), prev = this.last.get(name);
      if (!cfg || !prev || now - prev.ts >= cfg.minMs) { this.pending.delete(name); this.push(name, now, p.v, p.q); }
    }
    for (const name of this.logged.keys()) {
      const prev = this.last.get(name), cur = this.current.get(name);
      if (cur && (!prev || now - prev.ts >= ms)) this.push(name, now, cur.v, cur.q);
    }
  }

  push(name, ts, v, q) {
    this.last.set(name, { v, q, ts });
    this.buf.push([name, ts, q ? v : null, q]);
  }

  flush() {
    if (this.closed || !this.buf.length) return;
    const rows = this.buf;
    this.buf = [];
    try {
      this.db.exec('BEGIN');
      for (const [name, ts, v, q] of rows) this.st.sample.run(this.tagId(name), ts, v, q);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      console.error('Histórico: falha ao gravar', e.message);
    }
  }

  meta(k, v) {
    if (v === undefined) return this.st.metaGet.get(k)?.v ?? null;
    this.st.metaSet.run(k, String(v));
  }

  // ---------- Manutenção (a cada 5 minutos) ----------
  maintenance() {
    if (this.closed) return;
    try {
      this.flush();
      this.rollup();
      this.purge();
      this.enforceSize();
      this.db.exec('PRAGMA incremental_vacuum(2000)'); // devolve até ~8 MB por vez ao disco
    } catch (e) {
      console.error('Histórico: falha na manutenção', e.message);
    }
  }

  // Gera o resumo por minuto (média, mínimo e máximo) dos minutos já completos.
  rollup(now = Date.now()) {
    const upTo = Math.floor((now - 5000) / MIN) * MIN; // só minutos fechados (com margem para o que ainda está no buffer)
    let from = Number(this.meta('rollup_until'));
    const tags = this.st.tagAll.all();
    if (!Number.isFinite(from) || !from) {
      const firsts = tags.map((t) => this.st.rawFirst.get(t.id).t).filter((t) => t != null);
      if (!firsts.length) { this.meta('rollup_until', upTo); return 0; }
      from = Math.floor(Math.min(...firsts) / MIN) * MIN;
    }
    let n = 0;
    const STEP = 6 * 60 * MIN; // em blocos de 6 h para não segurar o banco por muito tempo
    for (let a = from; a < upTo; a += STEP) {
      const b = Math.min(upTo, a + STEP);
      this.db.exec('BEGIN');
      try {
        for (const t of tags) n += Number(this.st.rollup.run(t.id, a, b).changes);
        this.meta('rollup_until', b);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    return n;
  }

  // Apaga o que passou do prazo. Dados completos só saem depois de entrar no resumo.
  purge(now = Date.now()) {
    if (this.closed) return;
    const rollupUntil = Number(this.meta('rollup_until')) || 0;
    const rawCut = Math.min(now - this.cfg.rawDays * DAY, rollupUntil);
    const sumCut = now - this.cfg.summaryDays * DAY;
    this.db.exec('BEGIN');
    try {
      for (const t of this.st.tagAll.all()) {
        this.st.delRaw.run(t.id, rawCut);
        this.st.delSum.run(t.id, sumCut);
      }
      this.db.prepare('DELETE FROM alarm_events WHERE ts < ?').run(sumCut);
      this.db.prepare('DELETE FROM audit WHERE ts < ?').run(now - Math.max(this.cfg.summaryDays, 365) * DAY);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      console.error('Histórico: falha na limpeza', e.message);
    }
  }

  usedBytes() {
    const g = (p) => Number(Object.values(this.db.prepare(`PRAGMA ${p}`).get())[0]);
    return (g('page_count') - g('freelist_count')) * g('page_size');
  }

  // Limite de tamanho: apaga 10% do período mais antigo por vez até caber
  // (primeiro os dados completos, que já estão no resumo; depois o próprio resumo).
  enforceSize(now = Date.now()) {
    const limit = (Number(this.cfg.maxSizeMB) || 0) * 1048576;
    if (!limit || this.usedBytes() <= limit) return false;
    this.rollup(now);
    const rollupUntil = Number(this.meta('rollup_until')) || now;
    const tags = this.st.tagAll.all();
    const oldest = (stmt) => { const v = tags.map((t) => stmt.get(t.id).t).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
    for (let i = 0; i < 40 && this.usedBytes() > limit; i++) {
      const rawMin = oldest(this.st.rawFirst);
      const useRaw = rawMin != null && rawMin < rollupUntil && now - rawMin > DAY;
      const first = useRaw ? rawMin : oldest(this.st.sumFirst);
      if (first == null) break;
      const cut = Math.min(useRaw ? rollupUntil : now, first + Math.max(MIN, (now - first) * 0.1));
      this.db.exec('BEGIN');
      for (const t of tags) (useRaw ? this.st.delRaw : this.st.delSum).run(t.id, cut);
      this.db.exec('COMMIT');
      this.db.exec('PRAGMA incremental_vacuum');
      this.lastTrim = { ts: now, kind: useRaw ? 'completos' : 'resumo', until: cut };
    }
    console.warn(`Histórico ${path.basename(path.dirname(this.file))}: limite de ${this.cfg.maxSizeMB} MB atingido, dados ${this.lastTrim?.kind} apagados até ${new Date(this.lastTrim?.until).toLocaleString('pt-BR')}`);
    return true;
  }

  // Compactação completa (reorganiza o arquivo). Pode levar alguns segundos em bancos grandes.
  compact() {
    this.flush();
    const before = fileSize(this.file);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    return { before, after: fileSize(this.file) };
  }

  // ---------- Consultas ----------
  // Devolve no máximo `points` pontos por tag: [ts, média, mínimo, máximo].
  // Onde os dados completos já foram apagados, usa o resumo por minuto.
  series(tags, from, to, points = 1000) {
    this.flush();
    const bucket = Math.max(1, Math.ceil((to - from) / Math.max(10, points)));
    const qRaw = this.db.prepare(`
      SELECT MIN(ts) AS t, AVG(v) AS a, MIN(v) AS mn, MAX(v) AS mx, COUNT(v) AS n
      FROM samples WHERE tag_id = ? AND ts >= ? AND ts <= ?
      GROUP BY CAST((ts - ?) / ? AS INTEGER) ORDER BY t`);
    const qSum = this.db.prepare(`
      SELECT MIN(ts) AS t, SUM(a * n) * 1.0 / SUM(n) AS a, MIN(mn) AS mn, MAX(mx) AS mx, SUM(n) AS n
      FROM samples_min WHERE tag_id = ? AND ts >= ? AND ts < ?
      GROUP BY CAST((ts - ?) / ? AS INTEGER) ORDER BY t`);
    const beforeRaw = this.db.prepare('SELECT ts, v FROM samples WHERE tag_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1');
    const beforeSum = this.db.prepare('SELECT ts, a AS v FROM samples_min WHERE tag_id = ? AND ts < ? AND n > 0 ORDER BY ts DESC LIMIT 1');
    const pt = (r) => [r.t, r.n ? round(r.a) : null, r.n ? round(r.mn) : null, r.n ? round(r.mx) : null];
    const out = {}, summaryUntil = {};
    for (const name of tags) {
      const row = this.st.tagId.get(name);
      if (!row) { out[name] = []; continue; }
      const rawStart = this.st.rawFirst.get(row.id).t;
      const split = rawStart == null ? to + 1 : Math.max(from, rawStart);
      let pts = [];
      if (from < split) {
        pts = qSum.all(row.id, from, Math.min(split, to + 1), from, Math.max(bucket, MIN)).map(pt);
        if (pts.length) summaryUntil[name] = Math.min(split, to);
      }
      if (split <= to) pts = pts.concat(qRaw.all(row.id, split, to, from, bucket).map(pt));
      // Inclui o último valor antes do período para a linha começar no início do gráfico.
      const b = beforeRaw.get(row.id, from) || beforeSum.get(row.id, from);
      if (b && b.v != null) pts.unshift([from, round(b.v), round(b.v), round(b.v)]);
      out[name] = pts;
    }
    return { from, to, bucket, series: out, summaryUntil };
  }

  // Linhas para exportar em CSV: dados completos e, nos períodos antigos, o resumo por minuto.
  raw(tags, from, to, limit = 500000) {
    this.flush();
    const rows = [];
    const qRaw = this.db.prepare('SELECT ts, v, q FROM samples WHERE tag_id = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?');
    const qSum = this.db.prepare('SELECT ts, a, mn, mx, n FROM samples_min WHERE tag_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT ?');
    for (const name of tags) {
      const row = this.st.tagId.get(name);
      if (!row) continue;
      const rawStart = this.st.rawFirst.get(row.id).t;
      const split = rawStart == null ? to + 1 : Math.max(from, rawStart);
      if (from < split) {
        for (const r of qSum.all(row.id, from, Math.min(split, to + 1), limit)) {
          rows.push({ ts: r.ts, tag: name, v: r.n ? round(r.a) : null, mn: r.n ? round(r.mn) : null, mx: r.n ? round(r.mx) : null, q: r.n ? 1 : 0, kind: 'resumo' });
        }
      }
      if (split <= to) for (const r of qRaw.all(row.id, split, to, limit)) rows.push({ ts: r.ts, tag: name, v: r.v, mn: null, mx: null, q: r.q, kind: 'completo' });
    }
    return rows.sort((a, b) => a.ts - b.ts).slice(0, limit);
  }

  addAlarm(e) {
    try {
      this.st.alarm.run(e.ts, e.event, e.message, e.tag, e.value == null ? null : String(e.value), e.priority, e.user || '');
    } catch (err) {
      console.error('Histórico: falha ao gravar alarme', err.message);
    }
  }

  alarms({ from = 0, to = Date.now(), text = '', limit = 1000 } = {}) {
    const like = `%${text}%`;
    return this.db.prepare(`
      SELECT ts, event, message, tag, value, priority, user FROM alarm_events
      WHERE ts >= ? AND ts <= ? AND (? = '' OR message LIKE ? OR tag LIKE ?)
      ORDER BY ts DESC, id DESC LIMIT ?`).all(from, to, text, like, like, limit);
  }

  addAudit(e) {
    try {
      this.st.audit.run(e.ts, e.user, e.action, e.detail);
    } catch (err) {
      console.error('Histórico: falha ao gravar ação', err.message);
    }
  }

  audit({ from = 0, to = Date.now(), text = '', limit = 1000 } = {}) {
    const like = `%${text}%`;
    return this.db.prepare(`
      SELECT ts, user, action, detail FROM audit
      WHERE ts >= ? AND ts <= ? AND (? = '' OR user LIKE ? OR action LIKE ? OR detail LIKE ?)
      ORDER BY ts DESC, id DESC LIMIT ?`).all(from, to, text, like, like, like, limit);
  }

  stats() {
    this.flush();
    const raw = this.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n;
    const sum = this.db.prepare('SELECT COUNT(*) AS n FROM samples_min').get().n;
    const tags = this.st.tagAll.all();
    const firsts = (stmt) => { const v = tags.map((t) => stmt.get(t.id).t).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
    const firstRaw = firsts(this.st.rawFirst), firstSum = firsts(this.st.sumFirst);
    return {
      samples: raw, summaries: sum, first: [firstRaw, firstSum].filter((x) => x != null).sort((a, b) => a - b)[0] ?? null,
      firstRaw, firstSummary: firstSum, sizeBytes: fileSize(this.file), usedBytes: this.usedBytes(),
      rollupUntil: Number(this.meta('rollup_until')) || null, lastTrim: this.lastTrim, logged: [...this.logged.keys()], ...this.cfg,
    };
  }

  // Ocupação por tag: quantos registros cada um tem e quanto grava por dia.
  usage(now = Date.now()) {
    this.flush();
    const cRaw = this.db.prepare('SELECT COUNT(*) AS n FROM samples WHERE tag_id = ?');
    const cSum = this.db.prepare('SELECT COUNT(*) AS n FROM samples_min WHERE tag_id = ?');
    const cDay = this.db.prepare('SELECT COUNT(*) AS n FROM samples WHERE tag_id = ? AND ts >= ?');
    const used = this.usedBytes();
    const list = this.st.tagAll.all().map((t) => ({ tag: t.name, raw: cRaw.get(t.id).n, summary: cSum.get(t.id).n, lastDay: cDay.get(t.id, now - DAY).n, logged: this.logged.has(t.name) }));
    const weight = (x) => x.raw * RAW_BYTES + x.summary * SUM_BYTES;
    const total = list.reduce((s, x) => s + weight(x), 0) || 1;
    for (const x of list) { x.bytes = Math.round((weight(x) / total) * used); x.perDayBytes = x.lastDay * RAW_BYTES; }
    return list.sort((a, b) => b.bytes - a.bytes);
  }

  close() {
    clearInterval(this.flushTimer);
    clearInterval(this.beatTimer);
    clearInterval(this.maintTimer);
    clearTimeout(this.firstMaint);
    this.flush();
    this.closed = true;
    this.db.close();
  }
}

// Tamanho médio medido por registro no formato compacto (usado para estimar a ocupação por tag).
const RAW_BYTES = 23;
const SUM_BYTES = 42;

function fileSize(file) {
  let size = 0;
  for (const f of [file, file + '-wal']) try { size += fs.statSync(f).size; } catch {}
  return size;
}

function toNumber(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
}

const round = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);

module.exports = { Historian, normalizeConfig };
