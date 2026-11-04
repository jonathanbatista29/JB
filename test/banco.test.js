'use strict';
// Testes do banco de histórico: formato compacto, conversão do formato antigo, resumo por minuto,
// prazos, intervalo mínimo por tag, limite de tamanho, ocupação por tag e compactação.
const path = require('path');
const fs = require('fs');
const { tmpDir, sleep } = require('./helpers');
process.env.DATA_DIR = tmpDir();

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Historian, normalizeConfig } = require('../server/historian');

const MIN = 60000, DAY = 86400000;
const newDb = () => path.join(tmpDir(), 'historico.db');
const project = (tags, historian = {}) => ({ tags: tags.map((t) => ({ type: 'float32', log: true, ...t })), historian });

// Grava amostras diretamente (simula dados antigos já existentes no banco).
function insert(h, name, list) {
  for (const [ts, v] of list) h.push(name, ts, v, v == null ? 0 : 1);
  h.flush();
}

test('Configuração: valores padrão e conversão do formato antigo (retentionDays)', () => {
  assert.deepEqual(normalizeConfig({}), { rawDays: 14, summaryDays: 365, heartbeatSec: 60, maxSizeMB: 0 });
  assert.deepEqual(normalizeConfig({ retentionDays: 90 }), { rawDays: 14, summaryDays: 365, heartbeatSec: 60, maxSizeMB: 0 });
  assert.deepEqual(normalizeConfig({ retentionDays: 720 }), { rawDays: 14, summaryDays: 720, heartbeatSec: 60, maxSizeMB: 0 });
  assert.equal(normalizeConfig({ rawDays: 30, summaryDays: 10 }).summaryDays, 30, 'resumo nunca é menor que os dados completos');
});

test('Banco novo usa o formato compacto e devolve espaço ao disco', () => {
  const f = newDb();
  const h = new Historian(f);
  try {
    const sql = h.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'samples'").get().sql;
    assert.match(sql, /WITHOUT ROWID/);
    assert.equal(h.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2, 'auto_vacuum incremental');
    const idx = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'samples'").all();
    assert.equal(idx.length, 0, 'sem índices extras');
  } finally { h.close(); }
});

test('Histórico no formato antigo é convertido sem perder dados', () => {
  const f = newDb();
  const old = new DatabaseSync(f);
  old.exec(`CREATE TABLE tag_names (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE samples (tag_id INTEGER NOT NULL, ts INTEGER NOT NULL, v REAL, q INTEGER NOT NULL);
    CREATE INDEX samples_tag_ts ON samples (tag_id, ts); CREATE INDEX samples_ts ON samples (ts);
    CREATE TABLE alarm_events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT, message TEXT, tag TEXT, value TEXT, priority TEXT, user TEXT);
    INSERT INTO tag_names VALUES (1, 'Temp');
    INSERT INTO alarm_events (ts, event, message) VALUES (1000, 'ATIVO', 'antigo');`);
  const ins = old.prepare('INSERT INTO samples VALUES (1, ?, ?, 1)');
  const t0 = Date.now() - 3600000;
  old.exec('BEGIN');
  for (let i = 0; i < 2000; i++) ins.run(t0 + i * 1000, i / 10);
  old.exec('COMMIT');
  old.close();
  const h = new Historian(f);
  try {
    assert.match(h.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'samples'").get().sql, /WITHOUT ROWID/);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 2000);
    assert.equal(h.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2);
    assert.equal(h.alarms().length, 1, 'eventos de alarme preservados');
    const s = h.series(['Temp'], t0, t0 + 2000 * 1000, 2000);
    assert.equal(s.series.Temp.at(-1)[1], 199.9);
  } finally { h.close(); }
});

test('Resumo por minuto: média, mínimo e máximo corretos', () => {
  const h = new Historian(newDb());
  try {
    h.configure(project([{ name: 'P' }]));
    const m0 = Math.floor((Date.now() - 10 * MIN) / MIN) * MIN;
    insert(h, 'P', [[m0, 1], [m0 + 20000, 2], [m0 + 40000, 6], [m0 + MIN, 10], [m0 + MIN + 30000, null], [m0 + 2 * MIN + 5000, 4]]);
    h.rollup();
    const rows = h.db.prepare('SELECT ts, a, mn, mx, n FROM samples_min ORDER BY ts').all();
    assert.deepEqual(rows.slice(0, 3).map((r) => [r.ts - m0, r.a, r.mn, r.mx, r.n]), [[0, 3, 1, 6, 3], [MIN, 10, 10, 10, 1], [2 * MIN, 4, 4, 4, 1]]);
    assert.equal(h.rollup(), 0, 'não refaz o que já foi resumido');
  } finally { h.close(); }
});

test('Prazos: dados completos saem só depois de resumidos; gráfico e CSV usam o resumo', () => {
  const h = new Historian(newDb());
  try {
    h.configure(project([{ name: 'T' }], { rawDays: 2, summaryDays: 30 }));
    const now = Date.now();
    const old = Math.floor((now - 5 * DAY) / MIN) * MIN; // 5 dias atrás: além dos 2 dias completos
    const list = [];
    for (let i = 0; i < 120; i++) list.push([old + i * 1000, 50 + (i % 2)]); // 2 minutos de dados
    list.push([now - 1000, 70]);
    list.push([now - 40 * DAY, 1]); // além do prazo do resumo
    insert(h, 'T', list);
    h.purge(now); // ainda sem resumo: nada antigo pode sair
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 122);
    h.rollup(now);
    h.purge(now);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 1, 'só o dado recente continua completo');
    const sums = h.db.prepare('SELECT ts, a, mn, mx FROM samples_min ORDER BY ts').all();
    assert.equal(sums.length, 2, 'o resumo de 40 dias atrás saiu; os 2 minutos de 5 dias atrás ficaram');
    assert.deepEqual([sums[0].a, sums[0].mn, sums[0].mx], [50.5, 50, 51]);
    const s = h.series(['T'], old - MIN, now, 500);
    assert.ok(s.summaryUntil.T, 'indica que parte do gráfico vem do resumo');
    assert.ok(s.series.T.some((p) => p[1] === 50.5), 'gráfico mostra a média do minuto');
    assert.equal(s.series.T.at(-1)[1], 70, 'parte recente com dado completo');
    const rows = h.raw(['T'], old - MIN, now);
    assert.deepEqual(rows.map((r) => r.kind), ['resumo', 'resumo', 'completo']);
    assert.equal(rows[0].mx, 51);
  } finally { h.close(); }
});

test('Intervalo mínimo por tag: grava no máximo 1 vez por intervalo e não perde o último valor', async () => {
  const h = new Historian(newDb());
  try {
    h.configure(project([{ name: 'Rapido', logMinSec: 1 }, { name: 'Normal' }]));
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) {
      h.onValues({ Rapido: { v: i, q: 'good', ts: Date.now() }, Normal: { v: i, q: 'good', ts: Date.now() } });
      await sleep(100);
    }
    await sleep(1200);
    h.heartbeat();
    h.flush();
    const rap = h.raw(['Rapido'], t0 - 1, Date.now());
    const nor = h.raw(['Normal'], t0 - 1, Date.now());
    assert.ok(rap.length >= 3 && rap.length <= 5, `Rapido gravou ${rap.length} vezes em ~2,5 s`);
    assert.equal(nor.length, 25, 'tag sem intervalo grava toda mudança');
    assert.equal(rap.at(-1).v, 24, 'o último valor é gravado quando o intervalo passa');
  } finally { h.close(); }
});

test('Limite de tamanho: apaga o mais antigo até caber e o arquivo diminui', () => {
  const f = newDb();
  const h = new Historian(f);
  try {
    h.configure(project([{ name: 'A' }, { name: 'B' }], { rawDays: 3650, summaryDays: 3650 }));
    const now = Date.now();
    const start = now - 9 * DAY;
    for (const name of ['A', 'B']) {
      const list = [];
      for (let i = 0; i < 60000; i++) list.push([start + i * 12000, Math.sin(i / 50) * 100]);
      insert(h, name, list);
    }
    h.rollup(now);
    h.compact();
    const before = h.usedBytes();
    const fileBefore = fs.statSync(f).size;
    h.cfg.maxSizeMB = Math.max(1, Math.floor(before / 1048576 / 2));
    assert.equal(h.enforceSize(now), true);
    assert.ok(h.usedBytes() <= h.cfg.maxSizeMB * 1048576, `${h.usedBytes()} > limite`);
    // Ordem: primeiro os dados completos (já resumidos), mantendo pelo menos o último dia; só depois o resumo.
    const rawFirst = Math.min(h.st.rawFirst.get(h.tagId('A')).t, h.st.rawFirst.get(h.tagId('B')).t);
    assert.ok(now - rawFirst <= 1.2 * DAY, 'dados completos antigos apagados até sobrar ~1 dia');
    if (h.lastTrim.kind === 'resumo') assert.ok(h.st.sumFirst.get(h.tagId('A')).t > start, 'resumo cortado só no começo');
    h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(fs.statSync(f).size < fileBefore, 'o espaço volta para o disco');
    const s = h.series(['A'], start, now, 200);
    assert.ok(s.series.A.length > 10, 'o período apagado continua no gráfico pelo resumo');
    assert.equal(h.enforceSize(now), false, 'já está dentro do limite');
  } finally { h.close(); }
});

test('Ocupação por tag e compactação', () => {
  const h = new Historian(newDb());
  try {
    h.configure(project([{ name: 'Muito' }, { name: 'Pouco' }]));
    const now = Date.now();
    const muito = [], pouco = [];
    for (let i = 0; i < 5000; i++) muito.push([now - i * 1000, i]);
    for (let i = 0; i < 50; i++) pouco.push([now - i * 60000, i]);
    insert(h, 'Muito', muito);
    insert(h, 'Pouco', pouco);
    const u = h.usage(now);
    assert.equal(u[0].tag, 'Muito');
    assert.equal(u[0].raw, 5000);
    assert.equal(u[0].lastDay, 5000);
    assert.ok(u[0].bytes > u[1].bytes);
    h.db.exec('DELETE FROM samples');
    const r = h.compact();
    assert.ok(r.after < r.before, `compactar diminui o arquivo (${r.before} -> ${r.after})`);
    const st = h.stats();
    assert.equal(st.samples, 0);
    assert.equal(st.rawDays, 14);
  } finally { h.close(); }
});
