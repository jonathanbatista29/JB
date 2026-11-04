'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Usuários, sessões e registro de ações (auditoria).
// Os usuários ficam em data/users.json, separados do projeto, para que exportar o projeto não leve senhas.

const LEVELS = [
  { level: 1, name: 'Operador' },
  { level: 2, name: 'Manutenção' },
  { level: 3, name: 'Engenharia' },
  { level: 4, name: 'Administrador' },
];
const levelName = (l) => (l === 0 ? 'Visualizador' : l < 0 ? 'Sem acesso' : LEVELS.find((x) => x.level === l)?.name || String(l));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const SESSION_TTL = 12 * 60 * 60 * 1000; // sessão expira após 12 h sem uso
const COOKIE = 'jbihm_session';

let db = null;
const sessions = new Map(); // token -> { username, last }
const failures = new Map(); // ip -> { count, until }
let audit = [];

function hashPassword(pass, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return { salt, hash };
}

function checkPassword(user, pass) {
  const { hash } = hashPassword(pass, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function load() {
  if (fs.existsSync(USERS_FILE)) {
    db = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } else {
    db = { settings: { guestLevel: 0, idleMinutes: 10 }, users: [] };
  }
  db.settings = { guestLevel: 0, idleMinutes: 10, ...(db.settings || {}) };
  db.users ||= [];
  if (!db.users.some((u) => u.level === 4 && u.enabled !== false)) {
    // Primeiro uso: cria o administrador padrão, que deve trocar a senha no primeiro login.
    const existing = db.users.find((u) => u.username === 'admin');
    if (existing) Object.assign(existing, { level: 4, enabled: true });
    else db.users.push({ username: 'admin', name: 'Administrador', level: 4, enabled: true, mustChange: true, ...hashPassword('admin') });
    save();
  }
  try {
    audit = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-500).filter(Boolean).map((l) => JSON.parse(l)).reverse();
  } catch {
    audit = [];
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function log(user, action, detail = '') {
  const e = { ts: Date.now(), user: user || '(sem login)', action, detail: String(detail) };
  audit.unshift(e);
  if (audit.length > 500) audit.length = 500;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(e) + '\n');
  } catch {}
}

const publicUser = (u) => u && { username: u.username, name: u.name || u.username, level: u.level, levelName: levelName(u.level), mustChange: Boolean(u.mustChange) };
const findUser = (username) => db.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());

// ---------- Sessões ----------
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFrom(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const s = token && sessions.get(token);
  if (!s) return null;
  const user = findUser(s.username);
  if (!user || user.enabled === false || Date.now() - s.last > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  s.last = Date.now();
  return { token, user };
}

// Nível efetivo: do usuário logado ou, sem login, o nível de convidado das configurações.
function levelOf(sess) {
  return sess ? sess.user.level : Number(db.settings.guestLevel);
}

function login(req, res, username, password) {
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    const s = Math.ceil((f.until - Date.now()) / 1000);
    throw new Error(`Muitas tentativas. Aguarde ${s} s.`);
  }
  const user = findUser(username);
  if (!user || user.enabled === false || !checkPassword(user, password)) {
    const count = (f?.count || 0) + 1;
    failures.set(ip, { count, until: count >= 5 ? Date.now() + 30000 : 0 });
    log(username, 'Login recusado', ip);
    throw new Error('Usuário ou senha incorretos');
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, last: Date.now() });
  setCookie(req, res, token, SESSION_TTL / 1000);
  log(user.username, 'Login', ip);
  return publicUser(user);
}

function logout(req, res) {
  const s = sessionFrom(req);
  if (s) {
    sessions.delete(s.token);
    log(s.user.username, 'Logout');
  }
  setCookie(req, res, '', 0);
}

function setCookie(req, res, value, maxAge) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}${secure}`);
}

// Encerra as sessões de um usuário (senha trocada, nível alterado, desativado ou excluído).
function dropSessions(username, exceptToken) {
  for (const [t, s] of sessions) if (s.username.toLowerCase() === username.toLowerCase() && t !== exceptToken) sessions.delete(t);
}

// ---------- Gestão de usuários ----------
function validPassword(p) {
  if (String(p || '').length < 4) throw new Error('A senha precisa ter pelo menos 4 caracteres');
}

function changePassword(sess, oldPass, newPass) {
  const u = sess.user;
  if (!checkPassword(u, oldPass)) throw new Error('Senha atual incorreta');
  validPassword(newPass);
  if (oldPass === newPass) throw new Error('A nova senha deve ser diferente da atual');
  Object.assign(u, hashPassword(newPass), { mustChange: false });
  save();
  dropSessions(u.username, sess.token);
  log(u.username, 'Trocou a própria senha');
}

function listUsers() {
  return db.users.map((u) => ({ ...publicUser(u), enabled: u.enabled !== false }));
}

function activeAdmins(excluding) {
  return db.users.filter((u) => u.level === 4 && u.enabled !== false && u !== excluding).length;
}

function createUser(by, { username, name, level, password, enabled = true }) {
  username = String(username || '').trim();
  if (!/^[\w.\-@]{2,32}$/.test(username)) throw new Error('Usuário inválido (2 a 32 letras, números, . _ - @)');
  if (findUser(username)) throw new Error('Esse usuário já existe');
  level = Number(level);
  if (!LEVELS.some((l) => l.level === level)) throw new Error('Nível inválido');
  validPassword(password);
  db.users.push({ username, name: String(name || username), level, enabled: Boolean(enabled), mustChange: true, ...hashPassword(password) });
  save();
  log(by, 'Criou usuário', `${username} (${levelName(level)})`);
}

function updateUser(by, username, { name, level, enabled, password }) {
  const u = findUser(username);
  if (!u) throw new Error('Usuário não encontrado');
  const changes = [];
  if (level != null && Number(level) !== u.level) {
    if (!LEVELS.some((l) => l.level === Number(level))) throw new Error('Nível inválido');
    if (u.level === 4 && !activeAdmins(u)) throw new Error('Precisa existir pelo menos um administrador ativo');
    u.level = Number(level);
    changes.push('nível ' + levelName(u.level));
  }
  if (enabled != null && Boolean(enabled) !== (u.enabled !== false)) {
    if (!enabled && u.level === 4 && !activeAdmins(u)) throw new Error('Precisa existir pelo menos um administrador ativo');
    u.enabled = Boolean(enabled);
    changes.push(u.enabled ? 'ativado' : 'desativado');
  }
  if (name != null && name !== u.name) { u.name = String(name); changes.push('nome'); }
  if (password) {
    validPassword(password);
    Object.assign(u, hashPassword(password), { mustChange: true });
    changes.push('senha redefinida');
  }
  save();
  if (changes.some((c) => c !== 'nome')) dropSessions(u.username);
  if (changes.length) log(by, 'Alterou usuário', `${u.username}: ${changes.join(', ')}`);
}

function deleteUser(by, username) {
  const u = findUser(username);
  if (!u) throw new Error('Usuário não encontrado');
  if (u.username.toLowerCase() === String(by).toLowerCase()) throw new Error('Você não pode excluir o próprio usuário');
  if (u.level === 4 && !activeAdmins(u)) throw new Error('Precisa existir pelo menos um administrador ativo');
  db.users = db.users.filter((x) => x !== u);
  save();
  dropSessions(u.username);
  log(by, 'Excluiu usuário', u.username);
}

function getSettings() {
  return { ...db.settings };
}

function updateSettings(by, { guestLevel, idleMinutes }) {
  const g = Number(guestLevel), m = Number(idleMinutes);
  if (![-1, 0, 1].includes(g)) throw new Error('Acesso sem login inválido');
  if (!Number.isFinite(m) || m < 0 || m > 1440) throw new Error('Tempo de inatividade inválido (0 a 1440 min)');
  db.settings.guestLevel = g;
  db.settings.idleMinutes = m;
  save();
  log(by, 'Alterou configurações de acesso', `sem login: ${levelName(g)}, logout após ${m} min`);
}

module.exports = {
  LEVELS, levelName, load, log, login, logout, sessionFrom, levelOf, publicUser, changePassword,
  listUsers, createUser, updateUser, deleteUser, getSettings, updateSettings, getAudit: () => audit.slice(0, 300),
  isSessionAlive: (token) => sessions.has(token),
};
