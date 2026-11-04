'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Imagens das telas: ficam em data/projects/<endereço>/imagens/ e são servidas em /<endereço>/imagens/<arquivo>.
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const MIME = Object.fromEntries(Object.entries(TYPES).map(([m, e]) => [e, m]));
const MAX_BYTES = 5 * 1024 * 1024;
const FILE_RE = /^[a-z0-9][a-z0-9_-]{0,60}\.(png|jpg|gif|webp|svg)$/;

const dirOf = (projectDir) => path.join(projectDir, 'imagens');

function list(projectDir) {
  const dir = dirOf(projectDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { file: f, size: st.size, ts: st.mtimeMs };
  }).sort((a, b) => a.file.localeCompare(b.file));
}

// "Motor ligado.PNG" -> "motor-ligado"
function baseName(name) {
  return String(name || 'imagem').replace(/\.[^.]*$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'imagem';
}

// Salva uma imagem enviada como data URL (data:image/png;base64,...).
// Com `file`, grava com esse nome (usado ao restaurar backups); sem ele, cria um nome novo.
function save(projectDir, { name, data, file }) {
  const m = String(data || '').match(/^data:([a-z/+.-]+);base64,(.+)$/i);
  if (!m || !TYPES[m[1].toLowerCase()]) throw new Error('Formato não suportado (use PNG, JPG, GIF, WEBP ou SVG)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_BYTES) throw new Error('Imagem maior que 5 MB');
  const ext = TYPES[m[1].toLowerCase()];
  if (ext === 'svg' && /<script|on\w+\s*=|javascript:/i.test(buf.toString('utf8'))) throw new Error('SVG com scripts não é permitido');
  const dir = dirOf(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  let out = file && FILE_RE.test(file) && file.endsWith('.' + ext) ? file : null;
  if (!out) {
    const base = baseName(name);
    out = `${base}.${ext}`;
    if (fs.existsSync(path.join(dir, out))) out = `${base}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  }
  fs.writeFileSync(path.join(dir, out), buf);
  return out;
}

function remove(projectDir, file) {
  if (!FILE_RE.test(file)) throw new Error('Arquivo inválido');
  const f = path.join(dirOf(projectDir), file);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function filePath(projectDir, file) {
  if (!FILE_RE.test(file)) return null;
  const f = path.join(dirOf(projectDir), file);
  return fs.existsSync(f) ? f : null;
}

// Todas as imagens como data URL (vão junto no backup do projeto).
function exportAll(projectDir) {
  const out = {};
  for (const { file } of list(projectDir)) {
    const ext = file.split('.').pop();
    out[file] = `data:${MIME[ext]};base64,${fs.readFileSync(path.join(dirOf(projectDir), file)).toString('base64')}`;
  }
  return out;
}

function importAll(projectDir, images) {
  let n = 0;
  for (const [file, data] of Object.entries(images || {})) {
    try { save(projectDir, { file, data, name: file }); n++; } catch (e) { console.warn(`Imagem ${file} ignorada: ${e.message}`); }
  }
  return n;
}

// Quais imagens o projeto usa (objetos de imagem e fundo das telas).
function usedBy(project) {
  const used = new Set();
  for (const s of project.screens || []) {
    if (s.bgImage) used.add(s.bgImage);
    for (const w of s.widgets || []) {
      if (w.type === 'image') { if (w.props?.src) used.add(w.props.src); if (w.props?.srcOn) used.add(w.props.srcOn); }
    }
  }
  return used;
}

module.exports = { list, save, remove, filePath, exportAll, importAll, usedBy, MIME };
