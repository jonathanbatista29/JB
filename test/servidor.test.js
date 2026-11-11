'use strict';
// Testes de integração: sobe o servidor de verdade (pasta de dados temporária) e testa pela API.
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const WebSocket = require('ws');
const { startServer, Client, freePort, waitFor } = require('./helpers');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let srv, admin;
test.before(async () => {
  srv = await startServer();
  admin = new Client(srv.url);
  await admin.loginAdmin();
});
test.after(async () => { await srv?.stop(); });

test('Login e níveis de acesso', async () => {
  const anon = new Client(srv.url);
  assert.equal((await anon.post('/estacao-1/api/write', { tag: 'Motor_Liga', value: true })).status, 401, 'sem login não escreve');
  assert.equal((await anon.get('/estacao-1/api/project')).status, 200, 'sem login pode ver (padrão)');
  assert.equal((await anon.post('/api/login', { username: 'admin', password: 'errada' })).status, 400);

  assert.equal((await admin.post('/api/users', { username: 'oper', name: 'Operador', level: 1, password: '1234' })).status, 200);
  const op = new Client(srv.url);
  await op.post('/api/login', { username: 'oper', password: '1234' });
  assert.equal((await op.get('/estacao-1/api/values')).status, 403, 'senha inicial precisa ser trocada');
  await op.post('/api/me/password', { oldPassword: '1234', newPassword: '4321' });
  await op.post('/api/login', { username: 'oper', password: '4321' });
  assert.equal((await op.post('/estacao-1/api/write', { tag: 'Motor_Liga', value: true })).status, 200, 'operador comanda');
  const p = (await op.get('/estacao-1/api/project')).body;
  assert.equal((await op.put('/estacao-1/api/project', p)).status, 403, 'operador não salva o projeto');
  assert.equal((await op.get('/api/users')).status, 403, 'operador não vê usuários');
  assert.match((await admin.put('/api/users/admin', { level: 1 })).body.error, /administrador ativo/);
});

test('Manual em PDF disponível na IHM', async () => {
  const r = await new Client(srv.url).get('/manual', { raw: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await new Client(srv.url).get('/estacao-1/manual', { raw: true })).status, 200);
});

test('Vários projetos: endereço próprio e dados separados', async () => {
  const r = await admin.post('/api/projects', { name: 'Estação 2', template: 'empty' });
  assert.equal(r.body.slug, 'estacao-2');
  assert.equal((await admin.get('/estacao-2/', { raw: true })).status, 200);
  const red = await admin.get('/estacao-2', { raw: true });
  assert.equal(red.status, 301);
  assert.equal(red.headers.get('location'), '/estacao-2/');
  assert.equal((await admin.get('/nao-existe/', { raw: true })).status, 404);
  const p1 = (await admin.get('/estacao-1/api/project')).body;
  const p2 = (await admin.get('/estacao-2/api/project')).body;
  assert.ok(p1.tags.length > 0);
  assert.equal(p2.tags.length, 0);
  const list = (await admin.get('/api/projects')).body.map((p) => p.slug);
  assert.deepEqual(list.sort(), ['estacao-1', 'estacao-2']);
});

test('Modo produção trava a configuração e define a tela inicial', async () => {
  const p = (await admin.get('/estacao-1/api/project')).body;
  p.startScreen = p.screens[1].id;
  assert.equal((await admin.put('/estacao-1/api/project', p)).status, 200);
  assert.equal((await admin.post('/estacao-1/api/mode', { mode: 'production' })).body.mode, 'production');
  const blocked = await admin.put('/estacao-1/api/project', p);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /produção/);
  assert.equal((await admin.post('/estacao-1/api/images', { name: 'a.png', data: PNG })).status, 409);
  const mode = (await admin.get('/estacao-1/api/mode')).body;
  assert.equal(mode.startScreen, p.screens[1].id);
  assert.equal((await admin.post('/estacao-1/api/mode', { mode: 'edit' })).body.mode, 'edit');
  assert.equal((await admin.put('/estacao-1/api/project', p)).status, 200);
});

test('Sair da produção só com administrador (painel do operador pede a senha do admin)', async () => {
  assert.equal((await admin.post('/api/users', { username: 'eng', name: 'Engenheiro', level: 3, password: '1234' })).status, 200);
  const eng = new Client(srv.url);
  await eng.post('/api/login', { username: 'eng', password: '1234' });
  await eng.post('/api/me/password', { oldPassword: '1234', newPassword: 'eng#1' });
  await eng.post('/api/login', { username: 'eng', password: 'eng#1' });
  assert.equal((await eng.post('/estacao-1/api/mode', { mode: 'production' })).body.mode, 'production', 'engenharia coloca em produção');
  const r = await eng.post('/estacao-1/api/mode', { mode: 'edit' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /administrador/);
  // Operador logado no painel: senha errada e usuário sem nível não tiram da produção nem derrubam o login dele.
  const op = new Client(srv.url);
  await op.post('/api/login', { username: 'oper', password: '4321' });
  assert.match((await op.post('/estacao-1/api/mode', { mode: 'edit', username: 'admin', password: 'errada' })).body.error, /incorretos/);
  assert.match((await op.post('/estacao-1/api/mode', { mode: 'edit', username: 'eng', password: 'eng#1' })).body.error, /administrador/);
  assert.equal((await op.get('/estacao-1/api/me')).body.user.username, 'oper', 'operador continua logado');
  assert.equal((await op.get('/estacao-1/api/mode')).body.mode, 'production');
  const ok = await op.post('/estacao-1/api/mode', { mode: 'edit', username: 'admin', password: 'Teste#123' });
  assert.equal(ok.body.mode, 'edit');
  assert.equal((await op.get('/estacao-1/api/me')).body.user.username, 'admin', 'painel passa para o administrador');
});

test('Backup do projeto leva as imagens; importar e restaurar versão', async () => {
  const up = await admin.post('/estacao-1/api/images', { name: 'Logo.png', data: PNG });
  assert.equal(up.body.file, 'logo.png');
  assert.equal((await admin.get('/estacao-1/imagens/logo.png', { raw: true })).headers.get('content-type'), 'image/png');
  const exp = (await admin.get('/api/projects/estacao-1/export')).body;
  assert.equal(exp.jbihm, 'projeto');
  assert.ok(exp.images['logo.png']);
  const imp = await admin.post('/api/projects', { name: 'Importado', project: exp.project, images: exp.images });
  assert.equal((await admin.get(`/${imp.body.slug}/imagens/logo.png`, { raw: true })).status, 200);
  const before = (await admin.get('/estacao-2/api/project')).body;
  await admin.put('/estacao-2/api/project', { ...before, name: 'Alterado' });
  const v = (await admin.get('/api/projects/estacao-2/versions')).body;
  assert.ok(v.length >= 1);
  await admin.post(`/api/projects/estacao-2/versions/${v[0].file}/restore`);
  assert.notEqual((await admin.get('/estacao-2/api/project')).body.name, 'Alterado');
});

test('Histórico: baixar e restaurar o .db (e recusar arquivo inválido)', async () => {
  await waitFor(async () => (await admin.get('/estacao-1/api/history/stats')).body.samples > 0, { msg: 'gravar histórico' });
  const r = await admin.get('/api/projects/estacao-1/history-db', { raw: true });
  const db = Buffer.from(await r.arrayBuffer());
  assert.equal(db.subarray(0, 15).toString(), 'SQLite format 3');
  const ok = await admin.post('/api/projects/estacao-1/history-db', db);
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.body.kept, /^historico_antes_/);
  const bad = await admin.post('/api/projects/estacao-1/history-db', Buffer.from('isto não é um banco'));
  assert.equal(bad.status, 400);
  await waitFor(async () => (await admin.get('/estacao-1/api/history/stats')).body.samples > 0, { msg: 'histórico continuar gravando' });
});

test('Backup automático: rodar agora, listar e restaurar como cópia', async () => {
  assert.equal((await admin.put('/api/auto-backup', { enabled: true, time: '23:59', keep: 3, includeHistory: true })).status, 200);
  const run = await admin.post('/api/auto-backup/run');
  assert.equal(run.status, 200, run.text);
  const list = (await admin.get('/api/auto-backup')).body.backups;
  assert.equal(list[0].name, run.body.name);
  assert.ok(list[0].history.includes('estacao-1'));
  const res = await admin.post(`/api/auto-backup/${run.body.name}/restore`, { overwrite: false, history: true });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.created.length >= 2);
  assert.ok(res.body.history.length >= 1);
});

test('WebSocket: valores ao vivo e escrita com permissão', async () => {
  const ws = new WebSocket(srv.url.replace('http', 'ws') + '/estacao-1/ws', { headers: { Cookie: admin.cookie } });
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await waitFor(() => msgs.some((m) => m.type === 'snapshot'), { msg: 'snapshot' });
  ws.send(JSON.stringify({ type: 'write', id: 1, tag: 'Setpoint_Temp', value: 42 }));
  const res = await waitFor(() => msgs.find((m) => m.type === 'writeResult'), { msg: 'resposta da escrita' });
  assert.equal(res.ok, true);
  await waitFor(() => msgs.some((m) => m.type === 'values' && m.values.Setpoint_Temp?.v === 42), { msg: 'valor novo' });
  ws.close();
  const anon = new WebSocket(srv.url.replace('http', 'ws') + '/estacao-1/ws');
  const am = [];
  anon.on('message', (m) => am.push(JSON.parse(m)));
  await waitFor(() => am.some((m) => m.type === 'snapshot'), { msg: 'snapshot visitante' });
  anon.send(JSON.stringify({ type: 'write', id: 2, tag: 'Setpoint_Temp', value: 1 }));
  const r2 = await waitFor(() => am.find((m) => m.type === 'writeResult'), { msg: 'resposta visitante' });
  assert.equal(r2.ok, false, 'visitante não escreve');
  anon.close();
});

test('HTTPS: gerar certificado, ligar e acessar com WebSocket seguro', async () => {
  const port = await freePort();
  assert.match((await admin.put('/api/https', { enabled: true })).body.error, /certificado/);
  const g = (await admin.post('/api/https/generate', { hosts: ['ihm.teste.local'] })).body;
  assert.match(g.cert.altNames, /ihm\.teste\.local/);
  const s = (await admin.put('/api/https', { enabled: true, port })).body;
  assert.equal(s.running, true, JSON.stringify(s));
  const code = await new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${port}/estacao-1/`, { rejectUnauthorized: false }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(code, 200);
  const wss = new WebSocket(`wss://127.0.0.1:${port}/estacao-1/ws`, { rejectUnauthorized: false });
  const got = await new Promise((resolve, reject) => { wss.once('message', (m) => resolve(JSON.parse(m).type)); wss.once('error', reject); });
  assert.equal(got, 'snapshot');
  wss.close();
  assert.equal((await new Client(srv.url).get('/api/https/cert.crt', { raw: true })).status, 200, 'certificado público para instalar');
  await admin.put('/api/https', { enabled: false });
});
