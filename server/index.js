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
const images = require('./images');
const { AutoBackup } = require('./autobackup');
const { HttpsManager } = require('./https');

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
const autoBackup = new AutoBackup(pm, { log: (who, action, detail) => auth.log(who || '(sistema)', action, detail) });
autoBackup.start();
let httpsMgr = null; // criado depois do WebSocket (precisa do mesmo tratamento de upgrade)

const app = express();
app.use((req, res, next) => (httpsMgr ? httpsMgr.redirectMiddleware()(req, res, next) : next()));
app.use(express.json({ limit: '80mb' })); // backups levam as imagens junto

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
// Manual em PDF (funciona sem internet; abre no navegador).
app.get(['/manual', '/:slug/manual'], (req, res) => {
  res.type('application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="Manual_JB_IHM.pdf"');
  res.sendFile(path.join(__dirname, '..', 'docs', 'manual', 'Manual_JB_IHM.pdf'));
});
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
  const { name, template, from, project, images: imgs } = req.body || {};
  let base = null;
  if (project) base = project;
  else if (from) base = rtOf(from).project;
  else if (template === 'demo') base = storage.demoProject();
  const rt = pm.create(name, base);
  // Imagens: do backup importado ou copiadas do projeto de origem.
  images.importAll(rt.dir, imgs || (from ? images.exportAll(rtOf(from).dir) : null));
  auth.log(req.who, 'Criou projeto', `${rt.project.name} (/${rt.slug}/)${from ? ' cópia de ' + from : project ? ' importado' : ''}`);
  refreshSockets();
  return { ok: true, slug: rt.slug };
}));

root.post('/projects/:slug/mode', need(LV.ENG), wrap((req) => setMode(rtOf(req.params.slug), req.body.mode, req.who)));
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
  res.send(JSON.stringify({ jbihm: 'projeto', version: 1, exportedAt: new Date().toISOString(), slug: rt.slug, project: rt.project, images: images.exportAll(rt.dir) }, null, 2));
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
root.post('/projects/:slug/versions/:file/restore', need(LV.ENG), blockInProduction, wrap(async (req) => {
  const rt = rtOf(req.params.slug);
  const p = storage.loadVersion(rt.dir, req.params.file);
  await rt.apply(p);
  auth.log(req.who, 'Restaurou versão do projeto', `/${rt.slug}/ ← ${req.params.file}`);
}));

// Backup geral: todos os projetos num arquivo só (sem usuários e sem histórico).
root.get('/backup', need(LV.ADMIN), wrap((req, res) => {
  const projects = [...pm.runtimes.values()].map((rt) => ({ slug: rt.slug, project: rt.project, images: images.exportAll(rt.dir) }));
  download(res, `jbihm_backup_geral_${stamp()}.json`, 'application/json');
  res.send(JSON.stringify({ jbihm: 'backup', version: 1, exportedAt: new Date().toISOString(), projects }, null, 2));
  auth.log(req.who, 'Backup geral', `${projects.length} projeto(s)`);
}));

root.post('/backup/restore', need(LV.ADMIN), wrap(async (req) => {
  const b = req.body || {};
  const out = await restoreBundle(b, Boolean(b.overwrite), req.who);
  return { ok: true, created: out.created.map((c) => c.slug), replaced: out.replaced };
}));

// Restaura um backup geral (arquivo enviado ou backup automático). Devolve o que foi criado/substituído.
async function restoreBundle(b, overwrite, who) {
  if (b?.jbihm !== 'backup' || !Array.isArray(b.projects)) throw new Error('Arquivo não é um backup geral da JB IHM');
  const out = { created: [], replaced: [] };
  for (const item of b.projects) {
    const rt = pm.get(item.slug);
    if (rt && overwrite) {
      images.importAll(rt.dir, item.images);
      await rt.apply(item.project);
      out.replaced.push(item.slug);
    } else {
      const name = (item.project?.name || item.slug) + (rt ? ' (restaurado)' : '');
      const nrt = pm.create(name, item.project, item.slug);
      images.importAll(nrt.dir, item.images);
      out.created.push({ from: item.slug, slug: nrt.slug });
    }
  }
  auth.log(who, 'Restaurou backup geral', `novos: ${out.created.map((c) => c.slug).join(', ') || '-'}; substituídos: ${out.replaced.join(', ') || '-'}`);
  refreshSockets();
  return out;
}

// ---------- Restaurar histórico (.db) de um projeto ----------
root.post('/projects/:slug/history-db', need(LV.ENG), blockInProduction, wrap(async (req) => {
  const rt = rtOf(req.params.slug);
  const tmp = path.join(os.tmpdir(), `jbihm_upload_${process.pid}_${Date.now()}.db`);
  const MAX = 2 * 1024 * 1024 * 1024;
  try {
    await new Promise((resolve, reject) => {
      let size = 0;
      const out = fs.createWriteStream(tmp);
      req.on('data', (c) => { size += c.length; if (size > MAX) { req.destroy(); reject(new Error('Arquivo maior que 2 GB')); } });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    const r = rt.replaceHistory(tmp);
    auth.log(req.who, 'Restaurou histórico', `/${rt.slug}/ (anterior guardado como ${r.kept || '-'})`);
    return { ok: true, ...r };
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}));

// ---------- Backup automático diário ----------
root.get('/auto-backup', need(LV.ADMIN), (req, res) => res.json({ ...autoBackup.settings(), backups: autoBackup.list() }));
root.put('/auto-backup', need(LV.ADMIN), wrap((req) => {
  const s = autoBackup.update(req.body || {});
  auth.log(req.who, 'Configurou backup automático', `${s.enabled ? 'ligado' : 'desligado'}, ${s.time}, ${s.keep} cópia(s), pasta ${s.folderPath}`);
  return s;
}));
root.post('/auto-backup/run', need(LV.ADMIN), wrap((req) => autoBackup.run('manual', req.who)));
root.post('/auto-backup/:name/restore', need(LV.ADMIN), wrap(async (req) => {
  const { overwrite = false, history = false } = req.body || {};
  const bundle = JSON.parse(fs.readFileSync(autoBackup.bundlePath(req.params.name), 'utf8'));
  const out = await restoreBundle(bundle, overwrite, req.who);
  const hist = [];
  if (history) {
    const targets = [...out.replaced.map((s) => ({ from: s, slug: s })), ...out.created];
    for (const t of targets) {
      const f = autoBackup.historyPath(req.params.name, t.from);
      const rt = pm.get(t.slug);
      if (!f || !rt) continue;
      if (rt.mode.mode === 'production') { hist.push(`${t.slug}: em produção, histórico não restaurado`); continue; }
      rt.replaceHistory(f);
      hist.push(t.slug);
    }
    auth.log(req.who, 'Restaurou histórico do backup automático', `${req.params.name}: ${hist.join(', ') || '-'}`);
  }
  return { ok: true, created: out.created.map((c) => c.slug), replaced: out.replaced, history: hist };
}));

// ---------- HTTPS ----------
root.get('/https', need(LV.ADMIN), (req, res) => res.json(httpsMgr.status()));
root.put('/https', need(LV.ADMIN), wrap(async (req) => {
  const s = await httpsMgr.update(req.body || {});
  auth.log(req.who, 'Configurou HTTPS', `${s.enabled ? 'ligado' : 'desligado'}, porta ${s.port}${s.redirect ? ', redireciona HTTP' : ''}`);
  return s;
}));
root.post('/https/generate', need(LV.ADMIN), wrap(async (req) => {
  const s = await httpsMgr.generate(Array.isArray(req.body?.hosts) ? req.body.hosts : []);
  auth.log(req.who, 'Gerou certificado HTTPS', s.cert?.altNames || '');
  return s;
}));
root.post('/https/cert', need(LV.ADMIN), wrap(async (req) => {
  const s = await httpsMgr.setCustom(String(req.body?.cert || ''), String(req.body?.key || ''));
  auth.log(req.who, 'Instalou certificado HTTPS próprio', s.cert?.subject || '');
  return s;
}));
// Certificado público, para instalar nos tablets/PCs e o navegador confiar (não contém a chave privada).
root.get('/https/cert.crt', (req, res) => {
  const pem = httpsMgr.publicCert();
  if (!pem) return res.status(404).json({ ok: false, error: 'Sem certificado' });
  download(res, 'jbihm.crt', 'application/x-x509-ca-cert');
  res.send(pem);
});

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
proj.get('/mode', need(LV.VIEW), (req, res) => res.json({ ...req.rt.mode, startScreen: req.rt.project.startScreen }));
proj.post('/mode', need(LV.ENG), wrap((req) => setMode(req.rt, req.body.mode, req.who)));
proj.put('/project', need(LV.ENG), blockInProduction, wrap(async (req) => {
  const p = await req.rt.apply(req.body);
  auth.log(req.who, 'Salvou o projeto', `/${req.rt.slug}/: ${p.screens.length} tela(s), ${p.tags.length} tag(s)`);
}));
proj.get('/values', need(LV.VIEW), (req, res) => res.json(req.rt.tm.values));
// Lista de tags do PLC (CompactLogix/ControlLogix) para importar.
proj.get('/connections/:id/browse', need(LV.ENG), wrap((req) => {
  const st = req.rt.tm.conns.get(req.params.id);
  if (!st) throw new Error('Conexão desativada ou não salva');
  if (typeof st.driver.browse !== 'function') throw new Error('Este tipo de PLC não informa a lista de tags');
  if (!st.connected) throw new Error('PLC desconectado: verifique a comunicação na aba PLCs');
  return st.driver.browse();
}));
proj.post('/write', need(LV.OPERATOR), wrap((req) => doWrite(req.rt, req.level, req.who, req.body.tag, req.body.value)));

// Em produção a configuração do projeto fica travada (volte para o modo edição para alterar).
function blockInProduction(req, res, next) {
  const rt = req.rt || pm.get(req.params.slug);
  if (rt?.mode.mode === 'production') {
    return res.status(409).json({ ok: false, error: 'Projeto em produção: volte para o modo edição para alterar' });
  }
  next();
}

function setMode(rt, mode, who) {
  const m = rt.setMode(mode, who);
  const start = rt.project.screens.find((s) => s.id === rt.project.startScreen)?.name;
  auth.log(who, mode === 'production' ? 'Colocou em produção' : 'Voltou para edição', `/${rt.slug}/${mode === 'production' ? ' (tela inicial: ' + start + ')' : ''}`);
  return { ok: true, ...m };
}

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
  const n = (v) => (v == null ? '' : String(v).replace('.', ','));
  res.write('\ufeffdata_hora;tag;valor;minimo;maximo;qualidade;tipo\n');
  for (const r of rows) res.write(`${csvDate(r.ts)};${r.tag};${n(r.v)};${n(r.mn)};${n(r.mx)};${r.q ? 'boa' : 'ruim'};${r.kind === 'resumo' ? 'resumo 1 min' : 'completo'}\n`);
  res.end();
  auth.log(req.who, 'Exportou histórico', `/${req.rt.slug}/: ${tagList(req).join(', ')} (${rows.length} linhas)`);
}));
proj.get('/alarm-history', need(LV.VIEW), wrap((req) => req.rt.hist.alarms(range(req, Infinity))));
proj.get('/history/stats', need(LV.VIEW), (req, res) => res.json(req.rt.hist.stats()));
proj.get('/history/usage', need(LV.MAINT), wrap((req) => req.rt.hist.usage()));
proj.post('/history/compact', need(LV.ENG), wrap((req) => {
  const r = req.rt.hist.compact();
  auth.log(req.who, 'Compactou histórico', `/${req.rt.slug}/: ${(r.before / 1048576).toFixed(1)} MB → ${(r.after / 1048576).toFixed(1)} MB`);
  return { ok: true, ...r };
}));

// Rastreabilidade: consulta e exportação dos registros
const traceQuery = (req) => ({ def: req.query.def || '', code: String(req.query.code || '').slice(0, 100), from: req.query.from, to: req.query.to,
  result: req.query.result, limit: req.query.limit, offset: req.query.offset });
proj.get('/trace', need(LV.VIEW), wrap((req) => req.rt.trace.search(traceQuery(req))));
proj.get('/trace/state', need(LV.VIEW), (req, res) => res.json(req.rt.trace.state()));
proj.get('/trace.csv', need(LV.VIEW), wrap((req, res) => {
  const q = traceQuery(req);
  const defs = req.rt.trace.cfg.defs;
  const one = defs.find((d) => d.id === q.def);
  const rows = [...req.rt.trace.iterate(q)];
  // Colunas de dados: as da configuração (na ordem) e depois qualquer outra que esteja gravada.
  const cols = [], labels = new Map();
  for (const d of one ? [one] : defs) for (const f of d.fields) if (!labels.has(f.tag)) { cols.push(f.tag); labels.set(f.tag, f.label || f.tag); }
  for (const r of rows) for (const k of Object.keys(r.data)) if (!labels.has(k)) { cols.push(k); labels.set(k, k); }
  const cell = (v) => {
    if (v == null) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    if (typeof v === 'boolean') return v ? '1' : '0';
    const s = String(v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const defName = new Map(defs.map((d) => [d.id, d.name || d.id]));
  download(res, `rastreabilidade_${req.rt.slug}_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv; charset=utf-8');
  res.write('\ufeff' + ['data_hora', 'registro', 'codigo', 'resultado', 'operador', ...cols.map((c) => labels.get(c))].map(cell).join(';') + '\n');
  for (const r of rows) {
    res.write([csvDate(r.ts), defName.get(r.def) || r.def, r.code, r.result == null ? '' : r.result ? 'OK' : 'NOK', r.user, ...cols.map((c) => r.data[c])].map(cell).join(';') + '\n');
  }
  res.end();
  auth.log(req.who, 'Exportou rastreabilidade', `/${req.rt.slug}/: ${rows.length} registro(s)${q.code ? ', código ' + q.code : ''}`);
}));

// Imagens do projeto (biblioteca usada pelas telas)
proj.get('/images', need(LV.VIEW), (req, res) => {
  const used = images.usedBy(req.rt.project);
  res.json(images.list(req.rt.dir).map((i) => ({ ...i, used: used.has(i.file) })));
});
proj.post('/images', need(LV.ENG), blockInProduction, wrap((req) => {
  const file = images.save(req.rt.dir, req.body || {});
  auth.log(req.who, 'Enviou imagem', `/${req.rt.slug}/: ${file}`);
  return { ok: true, file };
}));
proj.delete('/images/:file', need(LV.ENG), blockInProduction, wrap((req) => {
  if (images.usedBy(req.rt.project).has(req.params.file)) throw new Error('Imagem em uso numa tela salva. Tire das telas e salve antes de excluir.');
  images.remove(req.rt.dir, req.params.file);
  auth.log(req.who, 'Excluiu imagem', `/${req.rt.slug}/: ${req.params.file}`);
}));

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
// Arquivos de imagem: só para quem pode ver o projeto. CSP impede scripts (ex.: em SVG aberto direto).
app.get('/:slug/imagens/:file', session, (req, res, next) => {
  if (!req.rt) return next();
  if (req.level < LV.VIEW) return res.status(401).end();
  const f = images.filePath(req.rt.dir, req.params.file);
  if (!f) return res.status(404).end();
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.type(images.MIME[f.split('.').pop()]).sendFile(f);
});
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

function onUpgrade(req, socket, head) {
  const m = String(req.url).match(/^\/([^/?#]+)\/ws(?:[?#]|$)/);
  const rt = m && pm.get(decodeURIComponent(m[1]));
  if (!rt) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, rt));
}
server.on('upgrade', onUpgrade);
httpsMgr = new HttpsManager({ app, onUpgrade });
httpsMgr.start();

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
  ws.send(JSON.stringify({ type: 'trace', defs: rt.trace.state() }));
  ws.send(JSON.stringify({ type: 'mode', ...rt.mode, startScreen: rt.project.startScreen }));
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
    try { autoBackup.stop(); await httpsMgr.stop(); await pm.stopAll(); systemHist.close(); } catch {}
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`JB IHM rodando em http://localhost:${PORT}/`);
  for (const p of pm.list()) console.log(`  ${p.name}: http://localhost:${PORT}/${p.slug}/`);
});
