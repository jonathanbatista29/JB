'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Histórico em banco de dados SQLite (arquivo data/historico.db):
//  - valores dos tags marcados para registro (por mudança, com banda morta, e periódico)
//  - eventos de alarme
//  - registro de ações dos usuários
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'historico.db');
const DAY = 24 * 60 * 60 * 1000;

const DEFAULTS = { retentionDays: 90, heartbeatSec: 60 };

class Historian {
  constructor(file = DB_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS tag_names (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS samples (tag_id INTEGER NOT NULL, ts INTEGER NOT NULL, v REAL, q INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_tag_ts ON samples (tag_id, ts);
      CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
      CREATE TABLE IF NOT EXISTS alarm_events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT, message TEXT, tag TEXT, value TEXT, priority TEXT, user TEXT);
      CREATE INDEX IF NOT EXISTS alarm_ts ON alarm_events (ts);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT, action TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
    `);
    this.st = {
      tagId: this.db.prepare('SELECT id FROM tag_names WHERE name = ?'),
      tagIns: this.db.prepare('INSERT INTO tag_names (name) VALUES (?)'),
      sample: this.db.prepare('INSERT INTO samples (tag_id, ts, v, q) VALUES (?, ?, ?, ?)'),
      alarm: this.db.prepare('INSERT INTO alarm_events (ts, event, message, tag, value, priority, user) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      audit: this.db.prepare('INSERT INTO audit (ts, user, action, detail) VALUES (?, ?, ?, ?)'),
    };
    this.ids = new Map();
    this.cfg = { ...DEFAULTS };
    this.logged = new Map(); // tag -> { deadband }
    this.last = new Map();   // tag -> { v, q, ts } último valor gravado
    this.current = new Map(); // tag -> { v, q } valor atual
    this.buf = [];
    this.flushTimer = setInterval(() => this.flush(), 1000);
    this.beatTimer = setInterval(() => this.heartbeat(), 1000);
    this.purgeTimer = setInterval(() => this.purge(), 6 * 60 * 60 * 1000);
    this.firstPurge = setTimeout(() => this.purge(), 10000);
  }

  // Aplica a configuração do projeto: quais tags registrar e por quanto tempo guardar.
  configure(project) {
    this.cfg = { ...DEFAULTS, ...(project.historian || {}) };
    this.logged = new Map();
    for (const t of project.tags) {
      if (t.log && t.type !== 'string') this.logged.set(t.name, { deadband: Math.abs(Number(t.logDeadband) || 0) });
    }
    for (const k of [...this.last.keys()]) if (!this.logged.has(k)) this.last.delete(k);
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
      if (significant) this.push(name, val.ts || Date.now(), v, q);
    }
  }

  // Grava periodicamente mesmo sem mudança, para o gráfico não ficar sem pontos.
  heartbeat() {
    const ms = Math.max(1, Number(this.cfg.heartbeatSec) || 60) * 1000;
    const now = Date.now();
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

  purge() {
    if (this.closed) return;
    const days = Number(this.cfg.retentionDays) || DEFAULTS.retentionDays;
    const limit = Date.now() - days * DAY;
    try {
      this.db.prepare('DELETE FROM samples WHERE ts < ?').run(limit);
      this.db.prepare('DELETE FROM alarm_events WHERE ts < ?').run(limit);
      this.db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - Math.max(days, 365) * DAY);
    } catch (e) {
      console.error('Histórico: falha na limpeza', e.message);
    }
  }

  // ---------- Consultas ----------
  // Devolve no máximo `points` pontos por tag: [ts, média, mínimo, máximo].
  series(tags, from, to, points = 1000) {
    this.flush();
    const bucket = Math.max(1, Math.ceil((to - from) / Math.max(10, points)));
    const q = this.db.prepare(`
      SELECT MIN(ts) AS t, AVG(v) AS a, MIN(v) AS mn, MAX(v) AS mx, COUNT(v) AS n
      FROM samples WHERE tag_id = ? AND ts >= ? AND ts <= ?
      GROUP BY CAST((ts - ?) / ? AS INTEGER) ORDER BY t`);
    const before = this.db.prepare('SELECT ts, v FROM samples WHERE tag_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1');
    const out = {};
    for (const name of tags) {
      const row = this.st.tagId.get(name);
      if (!row) { out[name] = []; continue; }
      const pts = q.all(row.id, from, to, from, bucket).map((r) => [r.t, r.n ? round(r.a) : null, r.n ? round(r.mn) : null, r.n ? round(r.mx) : null]);
      // Inclui o último valor antes do período para a linha começar no início do gráfico.
      const b = before.get(row.id, from);
      if (b && b.v != null) pts.unshift([from, round(b.v), round(b.v), round(b.v)]);
      out[name] = pts;
    }
    return { from, to, bucket, series: out };
  }

  // Linhas brutas para exportar em CSV.
  raw(tags, from, to, limit = 500000) {
    this.flush();
    const ids = tags.map((n) => this.st.tagId.get(n)).filter(Boolean).map((r) => r.id);
    if (!ids.length) return [];
    return this.db.prepare(`
      SELECT s.ts, n.name AS tag, s.v, s.q FROM samples s JOIN tag_names n ON n.id = s.tag_id
      WHERE s.tag_id IN (${ids.map(() => '?').join(',')}) AND s.ts >= ? AND s.ts <= ?
      ORDER BY s.ts LIMIT ?`).all(...ids, from, to, limit);
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
    const c = this.db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM samples').get();
    let size = 0;
    for (const f of [this.file, this.file + '-wal']) try { size += fs.statSync(f).size; } catch {}
    return { samples: c.n, first: c.first, sizeBytes: size, logged: [...this.logged.keys()], ...this.cfg };
  }

  close() {
    clearInterval(this.flushTimer);
    clearInterval(this.beatTimer);
    clearInterval(this.purgeTimer);
    clearTimeout(this.firstPurge);
    this.flush();
    this.closed = true;
    this.db.close();
  }
}

function toNumber(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
}

const round = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);

module.exports = { Historian };
