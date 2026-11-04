'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'project.json');
const DEMO = path.join(__dirname, 'demo-project.json');

function normalize(p) {
  const out = typeof p === 'object' && p ? p : {};
  out.name = String(out.name || 'Projeto IHM');
  for (const k of ['connections', 'tags', 'screens', 'alarms']) if (!Array.isArray(out[k])) out[k] = [];
  out.historian = {
    retentionDays: Math.min(3650, Math.max(1, Number(out.historian?.retentionDays) || 90)),
    heartbeatSec: Math.min(3600, Math.max(1, Number(out.historian?.heartbeatSec) || 60)),
  };
  if (!out.screens.length) out.screens.push({ id: 'tela1', name: 'Principal', width: 1024, height: 600, bg: '#1e2530', widgets: [] });
  for (const s of out.screens) if (!Array.isArray(s.widgets)) s.widgets = [];
  // Cada tela tem um número único (usado na troca de tela pelo PLC).
  const used = new Set();
  for (const s of out.screens) {
    const n = Math.floor(Number(s.number));
    if (s.number === '' || s.number == null || !Number.isFinite(n) || n < 1) delete s.number;
    else if (used.has(n)) throw new Error(`Número de tela repetido: ${n} ("${s.name}")`);
    else { s.number = n; used.add(n); }
  }
  let next = 1;
  for (const s of out.screens) if (s.number == null) { while (used.has(next)) next++; s.number = next; used.add(next); }
  const nav = out.navigation && typeof out.navigation === 'object' ? out.navigation : {};
  out.navigation = { requestTag: String(nav.requestTag || ''), resetRequest: Boolean(nav.resetRequest), currentTag: String(nav.currentTag || '') };
  const names = new Set();
  for (const t of out.tags) {
    if (!t.name || names.has(t.name)) throw new Error(`Nome de tag vazio ou repetido: "${t.name || ''}"`);
    names.add(t.name);
  }
  return out;
}

function load() {
  const file = fs.existsSync(FILE) ? FILE : DEMO;
  return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function save(project) {
  const p = normalize(project);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, FILE);
  return p;
}

module.exports = { load, save, normalize, FILE };
