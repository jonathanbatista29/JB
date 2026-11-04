'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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
  // Biblioteca de botões de tela: número sequencial único.
  if (!Array.isArray(out.navButtons)) out.navButtons = [];
  const usedB = new Set();
  out.navButtons = out.navButtons.filter((b) => b && b.id);
  for (const b of out.navButtons) {
    const n = Math.floor(Number(b.number));
    if (n >= 1 && !usedB.has(n)) { b.number = n; usedB.add(n); } else delete b.number;
  }
  let nb = 1;
  for (const b of out.navButtons) if (b.number == null) { while (usedB.has(nb)) nb++; b.number = nb; usedB.add(nb); }
  // Gateway: ligações entre tags de conexões diferentes.
  if (!Array.isArray(out.gateway)) out.gateway = [];
  out.gateway = out.gateway.filter((b) => b && b.id).map((b) => ({
    id: String(b.id), name: String(b.name || ''), enabled: b.enabled !== false,
    source: String(b.source || ''), target: String(b.target || ''),
    mode: b.mode === 'pulse' ? 'pulse' : 'change',
    gain: b.gain === '' || b.gain == null ? 1 : Number(b.gain), offset: Number(b.offset) || 0,
    value: b.value ?? '', resetSource: Boolean(b.resetSource),
    condTag: String(b.condTag || ''), condValue: b.condValue === '' || b.condValue == null ? '' : Number(b.condValue),
  }));
  const nav = out.navigation && typeof out.navigation === 'object' ? out.navigation : {};
  out.navigation = { requestTag: String(nav.requestTag || ''), resetRequest: Boolean(nav.resetRequest), currentTag: String(nav.currentTag || '') };
  const names = new Set();
  for (const t of out.tags) {
    if (!t.name || names.has(t.name)) throw new Error(`Nome de tag vazio ou repetido: "${t.name || ''}"`);
    names.add(t.name);
  }
  return out;
}

const MAX_VERSIONS = 30;

// Lê o projeto de uma pasta (data/projects/<endereço>/project.json).
function load(dir) {
  const file = path.join(dir, 'project.json');
  return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Salva o projeto. Antes de gravar, guarda a versão anterior em backups/ (as últimas 30).
function save(dir, project, { keepVersion = true } = {}) {
  const p = normalize(project);
  const file = path.join(dir, 'project.json');
  fs.mkdirSync(dir, { recursive: true });
  if (keepVersion && fs.existsSync(file)) {
    const bdir = path.join(dir, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    fs.copyFileSync(file, path.join(bdir, `projeto_${stamp}.json`));
    const old = listVersions(dir).slice(MAX_VERSIONS);
    for (const v of old) fs.unlinkSync(path.join(bdir, v.file));
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);
  return p;
}

// Versões salvas automaticamente, da mais nova para a mais antiga.
function listVersions(dir) {
  const bdir = path.join(dir, 'backups');
  if (!fs.existsSync(bdir)) return [];
  return fs.readdirSync(bdir).filter((f) => /^projeto_[\d-]+\.json$/.test(f)).map((f) => {
    const st = fs.statSync(path.join(bdir, f));
    return { file: f, size: st.size, ts: st.mtimeMs };
  }).sort((a, b) => b.ts - a.ts || b.file.localeCompare(a.file));
}

function loadVersion(dir, file) {
  if (!/^projeto_[\d-]+\.json$/.test(file)) throw new Error('Versão inválida');
  return normalize(JSON.parse(fs.readFileSync(path.join(dir, 'backups', file), 'utf8')));
}

const demoProject = () => normalize(JSON.parse(fs.readFileSync(DEMO, 'utf8')));

module.exports = { load, save, normalize, listVersions, loadVersion, demoProject, DATA_DIR };
