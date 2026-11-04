'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const storage = require('./storage');
const models = require('./models');
const auth = require('./auth');
const { TagManager } = require('./tagManager');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Níveis: -1 sem acesso, 0 visualizar, 1 operador, 2 manutenção, 3 engenharia, 4 administrador
const LV = { VIEW: 0, OPERATOR: 1, MAINT: 2, ENG: 3, ADMIN: 4 };

auth.load();
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const tm = new TagManager();
let project = storage.load();
tm.load(project);

// Anexa a sessão em toda requisição da API.
app.use('/api', (req, res, next) => {
  req.sess = auth.sessionFrom(req);
  req.level = auth.levelOf(req.sess);
  req.who = req.sess?.user.username || null;
  next();
});

const need = (min) => (req, res, next) => {
  if (req.level >= min) return next();
  res.status(req.sess ? 403 : 401).json({ ok: false, error: req.sess ? 'Seu nível de acesso não permite esta ação' : 'Faça login para continuar' });
};

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    res.json(out ?? { ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
};

// Senha padrão ainda não trocada: só deixa trocar a senha ou sair.
const mustChangeBlock = (req, res, next) => {
  if (req.sess?.user.mustChange) return res.status(403).json({ ok: false, error: 'Troque sua senha antes de continuar' });
  next();
};

// ---------- Login ----------
app.get('/api/me', (req, res) => {
  const s = auth.getSettings();
  res.json({ user: auth.publicUser(req.sess?.user), level: req.level, guestLevel: s.guestLevel, idleMinutes: s.idleMinutes, levels: auth.LEVELS });
});
app.post('/api/login', wrap((req, res) => ({ ok: true, user: auth.login(req, res, req.body.username, req.body.password) })));
app.post('/api/logout', wrap((req, res) => { closeSockets(req.sess?.token); auth.logout(req, res); }));
app.post('/api/me/password', wrap((req) => {
  if (!req.sess) throw new Error('Faça login para continuar');
  auth.changePassword(req.sess, req.body.oldPassword, req.body.newPassword);
}));

app.use('/api', mustChangeBlock);

// ---------- Projeto ----------
app.get('/api/project', need(LV.VIEW), (req, res) => res.json(project));
app.put('/api/project', need(LV.ENG), wrap(async (req) => {
  project = storage.save(req.body);
  await tm.load(project);
  auth.log(req.who, 'Salvou o projeto', `${project.screens.length} tela(s), ${project.tags.length} tag(s)`);
}));
app.get('/api/models', need(LV.VIEW), (req, res) => res.json(models));
app.get('/api/values', need(LV.VIEW), (req, res) => res.json(tm.values));
app.post('/api/write', need(LV.OPERATOR), wrap((req) => doWrite(req.level, req.who, req.body.tag, req.body.value)));

// ---------- Usuários (administrador) ----------
app.get('/api/users', need(LV.ADMIN), (req, res) => res.json(auth.listUsers()));
app.post('/api/users', need(LV.ADMIN), wrap((req) => auth.createUser(req.who, req.body)));
app.put('/api/users/:username', need(LV.ADMIN), wrap((req) => { auth.updateUser(req.who, req.params.username, req.body); refreshSockets(); }));
app.delete('/api/users/:username', need(LV.ADMIN), wrap((req) => { auth.deleteUser(req.who, req.params.username); refreshSockets(); }));
app.get('/api/settings', need(LV.ADMIN), (req, res) => res.json(auth.getSettings()));
app.put('/api/settings', need(LV.ADMIN), wrap((req) => { auth.updateSettings(req.who, req.body); refreshSockets(); }));
app.get('/api/audit', need(LV.ADMIN), (req, res) => res.json(auth.getAudit()));

// Escrita em tag: confere o nível mínimo do tag (padrão: operador).
async function doWrite(level, who, tagName, value) {
  const tag = project.tags.find((t) => t.name === tagName);
  const min = Math.max(LV.OPERATOR, Number(tag?.writeLevel) || LV.OPERATOR);
  if (level < min) throw new Error(`Escrita em ${tagName} exige nível ${auth.levelName(min)}`);
  await tm.write(tagName, value);
  auth.log(who, 'Escrita', `${tagName} = ${JSON.stringify(value)}`);
}

// ---------- WebSocket (valores ao vivo) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1 && c.level >= LV.VIEW) c.send(data);
}

function closeSockets(token) {
  if (!token) return;
  for (const c of wss.clients) if (c.token === token) c.close(4001, 'logout');
}

// Após mudar usuários ou configurações, reavalia o acesso de cada conexão aberta.
function refreshSockets() {
  for (const c of wss.clients) {
    const sess = c.req && auth.sessionFrom(c.req);
    const level = auth.levelOf(sess);
    if ((c.token && !sess) || level !== c.level) c.close(4001, 'acesso alterado');
  }
}

tm.on('values', (values) => broadcast({ type: 'values', values }));
tm.on('status', (status) => broadcast({ type: 'status', status }));
tm.on('alarms', () => broadcast({ type: 'alarms', ...tm.alarmState() }));

wss.on('connection', (ws, req) => {
  const sess = auth.sessionFrom(req);
  ws.req = { headers: { cookie: req.headers.cookie } };
  ws.token = sess?.token || null;
  ws.level = sess?.user.mustChange ? -1 : auth.levelOf(sess);
  ws.who = sess?.user.username || null;
  if (ws.level < LV.VIEW) return ws.close(4001, 'login necessário');

  ws.send(JSON.stringify({ type: 'snapshot', values: tm.values, status: tm.status, ...tm.alarmState() }));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Sessão encerrada em outro lugar (logout, senha trocada): fecha a conexão.
    if (ws.token && !auth.isSessionAlive(ws.token)) return ws.close(4001, 'sessão expirada');
    if (ws.token) auth.sessionFrom(ws.req);
    if (msg.type === 'write') {
      try {
        await doWrite(ws.level, ws.who, msg.tag, msg.value);
        ws.send(JSON.stringify({ type: 'writeResult', id: msg.id, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'writeResult', id: msg.id, ok: false, error: e.message }));
      }
    } else if (msg.type === 'ack') {
      if (ws.level < LV.OPERATOR) return;
      tm.ack(msg.id, ws.who);
      auth.log(ws.who, 'Reconheceu alarme', msg.id === '*' ? 'todos' : msg.id);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`JB IHM rodando em http://localhost:${PORT}`);
});
