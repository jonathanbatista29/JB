'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const storage = require('./storage');
const models = require('./models');
const auth = require('./auth');
const { Historian } = require('./historian');
const { ProjectManager } = require('./projects');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');

// Níveis: -1 sem acesso, 0 visualizar, 1 operador, 2 manutenção, 3 engenharia, 4 administrador
const LV = { VIEW: 0, OPERATOR: 1, MAINT: 2, ENG: 3, ADMIN: 4 };

// Usuários e registro de ações são do servidor (valem para todos os projetos).
auth.load();
const systemHist = new Historian(path.join(storage.DATA_DIR, 'sistema.db'));
systemHist.configure({ tags: [], historian: { retentionDays: 365 } });
auth.setAuditSink(systemHist);

const pm = new ProjectManager();
pm.start({ systemHistorian: systemHist });

const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------- Utilidades ----------
const session = (req, res, next) => {
  req.sess = auth.sessionFrom(req);
  req.level = auth.levelOf(req.sess);
  req.who = req.sess?.user.username || null;
  next();
};

const need = (min) => (req, res, next) => {
  if (req.level >= min) return next();
  res.status(req.sess ? 403 : 401).json({ ok: false, error: req.sess ? 'Seu nível de acesso não permite esta ação' : 'Faça login para continuar' });
};

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ ok: false, error: e.message });
  }
};

// Senha padrão ainda não trocada: só deixa trocar a senha ou sair.
const mustChangeBlock = (req, res, next) => {
  if (req.sess?.user.mustChange) return res.status(403).json({ ok: false, error: 'Troque sua senha antes de continuar' });
  next();
};

const download = (res, name, type) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
};
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

// Rotas de login (iguais na raiz e em cada projeto).
function authRoutes(r) {
  r.get('/me', (req, res) => {
    const s = auth.getSettings();
    res.json({ user: auth.publicUser(req.sess?.user), level: req.level, guestLevel: s.guestLevel, idleMinutes: s.idleMinutes, levels: auth.LEVELS });
  });
  r.post('/login', wrap((req, res) => ({ ok: true, user: auth.login(req, res, req.body.username, req.body.password) })));
  r.post('/logout', wrap((req, res) => { closeSockets(req.sess?.token); auth.logout(req, res); }));
  r.post('/me/password', wrap((req) => {
    if (!req.sess) throw new Error('Faça login para continuar');
    auth.changePassword(req.sess, req.body.oldPassword, req.body.newPassword);
  }));
  r.use(mustChangeBlock);
  // Usuários e configurações de acesso (administrador)
  r.get('/users', need(LV.ADMIN), (req, res) => res.json(auth.listUsers()));
  r.post('/users', need(LV.ADMIN), wrap((req) => auth.createUser(req.who, req.body)));
  r.put('/users/:username', need(LV.ADMIN), wrap((req) => { auth.updateUser(req.who, req.params.username, req.body); refreshSockets(); }));
  r.delete('/users/:username', need(LV.ADMIN), wrap((req) => { auth.deleteUser(req.who, req.params.username); refreshSockets(); }));
  r.get('/settings', need(LV.ADMIN), (req, res) => res.json(auth.getSettings()));
  r.put('/settings', need(LV.ADMIN), wrap((req) => { auth.updateSettings(req.who, req.body); refreshSockets(); }));
  r.get('/audit', need(LV.ADMIN), wrap((req) => auth.getAudit(range(req, Infinity))));
  r.get('/models', need(LV.VIEW), (req, res) => res.json(models));
}

// ================= Raiz: lista de projetos, backup e restauração =================
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'projects.html')));
app.use(express.static(PUBLIC, { index: false }));

const root = express.Router();
root.use(session);
authRoutes(root);

const rtOf = (slug) => {
  const rt = pm.get(slug);
  if (!rt) throw new Error('Projeto não encontrado');
  return rt;
};

root.get('/projects', need(LV.VIEW), (req, res) => res.json(pm.list()));

// Novo projeto: vazio, exemplo, cópia de outro ou importado de um arquivo.
root.post('/projects', need(LV.ENG), wrap((req) => {
  const { name, template, from, project } = req.body || {};
  let base = null;
  if (project) base = project;
  else if (from) base = rtOf(from).project;
  else if (template === 'demo') base = storage.demoProject();
  const rt = pm.create(name, base);
  auth.log(req.who, 'Criou projeto', `${rt.project.name} (/${rt.slug}/)${from ? ' cópia de ' + from : project ? ' importado' : ''}`);
  refreshSockets();
  return { ok: true, slug: rt.slug };
}));

root.put('/projects/:slug/name', need(LV.ENG), wrap(async (req) => {
  const rt = rtOf(req.params.slug);
  const name = String(req.body.name || '').trim();
  if (!name) throw new Error('Informe o nome');
  await rt.apply({ ...rt.project, name });
  auth.log(req.who, 'Renomeou projeto', `/${rt.slug}/ → ${name}`);
}));

root.delete('/projects/:slug', need(LV.ADMIN), wrap(async (req) => {
  if (pm.runtimes.size <= 1) throw new Error('O servidor precisa de pelo menos um projeto');
  const dest = await pm.remove(req.params.slug);
  auth.log(req.who, 'Excluiu projeto', `/${req.params.slug}/ (movido para ${path.basename(dest)} na lixeira)`);
}));

// Backup de um projeto (configuração completa em JSON).
root.get('/projects/:slug/export', need(LV.ENG), wrap((req, res) => {
  const rt = rtOf(req.params.slug);
  download(res, `${rt.slug}_${stamp()}.json`, 'application/json');
  res.send(JSON.stringify({ jbihm: 'projeto', version: 1, exportedAt: new Date().toISOString(), slug: rt.slug, project: rt.project }, null, 2));
  auth.log(req.who, 'Backup do projeto', `/${rt.slug}/`);
}));

// Histórico do projeto (banco SQLite). VACUUM INTO gera uma cópia consistente com o banco em uso.
root.get('/projects/:slug/history-db', need(LV.ENG), wrap(async (req, res) => {
  const rt = rtOf(req.params.slug);
  rt.hist.flush();
  const tmp = path.join(os.tmpdir(), `jbihm_${rt.slug}_${Date.now()}.db`);
  rt.hist.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  download(res, `${rt.slug}_historico_${stamp()}.db`, 'application/octet-stream');
  await new Promise((resolve) => res.sendFile(tmp, () => { fs.unlink(tmp, () => {}); resolve(); }));
  auth.log(req.who, 'Backup do histórico', `/${rt.slug}/`);
}));

// Versões salvas automaticamente a cada "Salvar".
root.get('/projects/:slug/versions', need(LV.ENG), wrap((req) => storage.listVersions(rtOf(req.params.slug).dir)));
root.post('/projects/:slug/versions/:file/restore', need(LV.ENG), wrap(async (req) => {
  const rt = rtOf(req.params.slug);
  const p = storage.loadVersion(rt.dir, req.params.file);
  await rt.apply(p);
  auth.log(req.who, 'Restaurou versão do projeto', `/${rt.slug}/ ← ${req.params.file}`);
}));

// Backup geral: todos os projetos num arquivo só (sem usuários e sem histórico).
root.get('/backup', need(LV.ADMIN), wrap((req, res) => {
  const projects = [...pm.runtimes.values()].map((rt) => ({ slug: rt.slug, project: rt.project }));
  download(res, `jbihm_backup_geral_${stamp()}.json`, 'application/json');
  res.send(JSON.stringify({ jbihm: 'backup', version: 1, exportedAt: new Date().toISOString(), projects }, null, 2));
  auth.log(req.who, 'Backup geral', `${projects.length} projeto(s)`);
}));

root.post('/backup/restore', need(LV.ADMIN), wrap(async (req) => {
  const b = req.body || {};
  if (b.jbihm !== 'backup' || !Array.isArray(b.projects)) throw new Error('Arquivo não é um backup geral da JB IHM');
  const out = { created: [], replaced: [] };
  for (const item of b.projects) {
    const rt = pm.get(item.slug);
    if (rt && b.overwrite) { await rt.apply(item.project); out.replaced.push(item.slug); }
    else {
      const name = (item.project?.name || item.slug) + (rt ? ' (restaurado)' : '');
      out.created.push(pm.create(name, item.project, item.slug).slug);
    }
  }
  auth.log(req.who, 'Restaurou backup geral', `novos: ${out.created.join(', ') || '-'}; substituídos: ${out.replaced.join(', ') || '-'}`);
  refreshSockets();
  return { ok: true, ...out };
}));

app.use('/api', root);

// ================= Cada projeto: /<endereço>/ =================
app.use('/:slug', (req, res, next) => {
  const rt = pm.get(req.params.slug);
  if (!rt) return next();
  // /estacao-1 -> /estacao-1/ (os caminhos da página são relativos)
  if (req.path === '/' && !req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, `/${rt.slug}/`);
  req.rt = rt;
  next();
});

const proj = express.Router({ mergeParams: true });
proj.use((req, res, next) => (req.rt ? next() : res.status(404).json({ ok: false, error: 'Projeto não encontrado' })));
proj.use(session);
authRoutes(proj);

proj.get('/project', need(LV.VIEW), (req, res) => res.json(req.rt.project));
proj.put('/project', need(LV.ENG), wrap(async (req) => {
  const p = await req.rt.apply(req.body);
  auth.log(req.who, 'Salvou o projeto', `/${req.rt.slug}/: ${p.screens.length} tela(s), ${p.tags.length} tag(s)`);
}));
proj.get('/values', need(LV.VIEW), (req, res) => res.json(req.rt.tm.values));
proj.post('/write', need(LV.OPERATOR), wrap((req) => doWrite(req.rt, req.level, req.who, req.body.tag, req.body.value)));

// Histórico do projeto
function range(req, span = 60 * 60 * 1000) {
  const to = Number(req.query.to) || Date.now();
  const from = Number(req.query.from) || Math.max(0, to - span);
  if (from >= to) throw new Error('Período inválido');
  return { from, to, text: String(req.query.text || ''), limit: Math.min(5000, Number(req.query.limit) || 1000) };
}
const tagList = (req) => String(req.query.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12);

proj.get('/history', need(LV.VIEW), wrap((req) => {
  const { from, to } = range(req);
  return req.rt.hist.series(tagList(req), from, to, Math.min(4000, Number(req.query.points) || 1000));
}));
proj.get('/history.csv', need(LV.VIEW), wrap((req, res) => {
  const { from, to } = range(req);
  const rows = req.rt.hist.raw(tagList(req), from, to);
  download(res, `historico_${req.rt.slug}_${new Date(from).toISOString().slice(0, 10)}.csv`, 'text/csv; charset=utf-8');
  res.write('﻿data_hora;tag;valor;qualidade\n');
  for (const r of rows) res.write(`${csvDate(r.ts)};${r.tag};${r.v == null ? '' : String(r.v).replace('.', ',')};${r.q ? 'boa' : 'ruim'}\n`);
  res.end();
  auth.log(req.who, 'Exportou histórico', `/${req.rt.slug}/: ${tagList(req).join(', ')} (${rows.length} linhas)`);
}));
proj.get('/alarm-history', need(LV.VIEW), wrap((req) => req.rt.hist.alarms(range(req, Infinity))));
proj.get('/history/stats', need(LV.VIEW), (req, res) => res.json(req.rt.hist.stats()));

function csvDate(ts) {
  const d = new Date(ts), p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Escrita em tag: confere o nível mínimo do tag (padrão: operador).
async function doWrite(rt, level, who, tagName, value) {
  const tag = rt.project.tags.find((t) => t.name === tagName);
  const min = Math.max(LV.OPERATOR, Number(tag?.writeLevel) || LV.OPERATOR);
  if (level < min) throw new Error(`Escrita em ${tagName} exige nível ${auth.levelName(min)}`);
  await rt.tm.write(tagName, value);
  auth.log(who, 'Escrita', `/${rt.slug}/: ${tagName} = ${JSON.stringify(value)}`);
}

app.use('/:slug/api', proj);
app.use('/:slug', (req, res, next) => (req.rt ? express.static(PUBLIC)(req, res, next) : next()));

app.use((req, res) => {
  if (req.path.includes('/api/')) return res.status(404).json({ ok: false, error: 'Não encontrado' });
  res.status(404).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <body style="font-family:sans-serif;background:#12171f;color:#dbe3ee;padding:40px">
    <h2>Projeto não encontrado</h2><p><a style="color:#2d8cff" href="/">Ver a lista de projetos</a></p></body>`);
});

// ================= WebSocket: /<endereço>/ws =================
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const m = String(req.url).match(/^\/([^/?#]+)\/ws(?:[?#]|$)/);
  const rt = m && pm.get(decodeURIComponent(m[1]));
  if (!rt) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, rt));
});

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

function onConnection(ws, req, rt) {
  const sess = auth.sessionFrom(req);
  ws.req = { headers: { cookie: req.headers.cookie } };
  ws.token = sess?.token || null;
  ws.level = sess?.user.mustChange ? -1 : auth.levelOf(sess);
  ws.who = sess?.user.username || null;
  if (ws.level < LV.VIEW) return ws.close(4001, 'login necessário');
  rt.clients.add(ws);
  ws.on('close', () => rt.clients.delete(ws));

  ws.send(JSON.stringify({ type: 'snapshot', values: rt.tm.values, status: rt.tm.status, ...rt.tm.alarmState() }));
  ws.send(JSON.stringify({ type: 'gateway', bridges: rt.gw.state() }));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Sessão encerrada em outro lugar (logout, senha trocada): fecha a conexão.
    if (ws.token && !auth.isSessionAlive(ws.token)) return ws.close(4001, 'sessão expirada');
    if (ws.token) auth.sessionFrom(ws.req);
    if (msg.type === 'write') {
      try {
        await doWrite(rt, ws.level, ws.who, msg.tag, msg.value);
        ws.send(JSON.stringify({ type: 'writeResult', id: msg.id, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'writeResult', id: msg.id, ok: false, error: e.message }));
      }
    } else if (msg.type === 'screen') {
      rt.nav.reportScreen(String(msg.screen || ''));
    } else if (msg.type === 'ack') {
      if (ws.level < LV.OPERATOR) return;
      rt.tm.ack(msg.id, ws.who);
      auth.log(ws.who, 'Reconheceu alarme', `/${rt.slug}/: ${msg.id === '*' ? 'todos' : msg.id}`);
    }
  });
}

// Grava o que estiver pendente antes de encerrar.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await pm.stopAll(); systemHist.close(); } catch {}
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`JB IHM rodando em http://localhost:${PORT}/`);
  for (const p of pm.list()) console.log(`  ${p.name}: http://localhost:${PORT}/${p.slug}/`);
});
