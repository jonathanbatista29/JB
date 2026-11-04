// Tira os prints do manual (docs/manual/img) com a IHM real e o projeto de exemplo.
// Uso: npm install --no-save playwright && npx playwright install chromium && node scripts/manual-prints.js

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const { startServer, Client, sleep } = require('../test/helpers');
const OUT = path.join(__dirname, '..', 'docs', 'manual', 'img');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const srv = await startServer();
  const api = new Client(srv.url);
  // Prepara exemplos: 2ª estação, ligações de gateway e um alarme ativo
  await api.loginAdmin('Admin#2026');
  await api.post('/api/projects', { name: 'Estação 2', template: 'demo' });
  const p = (await api.get('/estacao-1/api/project')).body;
  p.gateway = [
    { id: 'g1', name: 'Nível para a velocidade', source: 'Nivel_Tanque', target: 'Velocidade', mode: 'change', gain: 18, offset: 0 },
    { id: 'g2', name: 'Simulador online', source: '@status:sim1', target: 'Bomba_Liga', mode: 'change', gain: 1 },
  ];
  await api.put('/estacao-1/api/project', p);
  await api.post('/api/users', { username: 'joao', name: 'João (operador)', level: 1, password: '1234' });
  await sleep(4000);

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 } });
  const pg = await ctx.newPage();
  const shot = async (name, opts = {}) => { await pg.waitForTimeout(opts.wait ?? 500); await pg.screenshot({ path: path.join(OUT, name + '.png'), ...opts.s }); console.log('ok', name); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('FALHOU', name, e.message.split('\n')[0]); } };

  // 1. Primeiro acesso
  await step('login', async () => {
    const fresh = await (await b.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
    const s2 = await startServer();
    await fresh.goto(s2.url + '/estacao-1/'); await fresh.waitForTimeout(900);
    await fresh.click('text=🔑 Entrar'); await fresh.fill('.login-form input[autocomplete=username]', 'admin'); await fresh.fill('.login-form input[type=password]', 'admin');
    await fresh.waitForTimeout(300); await fresh.screenshot({ path: path.join(OUT, '02-login.png') }); console.log('ok 02-login');
    await fresh.click('.login-form button[type=submit]'); await fresh.waitForSelector('text=Defina uma nova senha');
    await fresh.waitForTimeout(300); await fresh.screenshot({ path: path.join(OUT, '03-trocar-senha.png') }); console.log('ok 03-trocar-senha');
    await fresh.close(); await s2.stop();
  });

  // login como admin nesta página
  await pg.goto(srv.url + '/'); await pg.waitForTimeout(800);
  await pg.click('text=🔑 Entrar'); await pg.fill('.login-form input[autocomplete=username]', 'admin'); await pg.fill('.login-form input[type=password]', 'Admin#2026');
  await pg.click('.login-form button[type=submit]'); await pg.waitForTimeout(1200);
  await step('projetos', () => shot('01-lista-projetos'));
  await step('novo projeto', async () => { await pg.click('text=+ Novo projeto'); await pg.fill('.login-form input[type=text]', 'Estação 3'); await shot('04-novo-projeto'); await pg.click('.login-form >> text=Cancelar'); });

  // Operação
  await pg.goto(srv.url + '/estacao-1/'); await pg.waitForTimeout(1500);
  await step('operacao', () => shot('05-operacao', { wait: 1500 }));
  await step('teclado', async () => { await pg.click('.rt-stage .w-input'); await shot('06-teclado'); await pg.click('.keys button.cancel'); });
  await step('alarme', async () => { await pg.click('.rt-alarm'); await shot('07-alarmes', { wait: 800 }); });
  await step('tendencias', async () => { await pg.click('[data-page=runtime]'); await pg.click('.rt-nav >> text=Tendências'); await shot('08-tendencias', { wait: 3000 }); });

  // Editor
  await pg.click('[data-page=editor]'); await pg.waitForTimeout(700);
  await pg.selectOption('.ed-toolbar select >> nth=0', { index: 0 }); await pg.waitForTimeout(400);
  await step('editor', () => shot('09-editor'));
  await step('editor botao', async () => { await pg.click('.ed-stage .wgt[data-id=w13]'); await shot('10-editor-propriedades'); });
  await step('editor alcas', async () => {
    const r = await pg.locator('.ed-stage .wgt[data-id=w13] .rh-se').boundingBox();
    await pg.mouse.move(r.x + 5, r.y + 5); await pg.mouse.down(); await pg.mouse.move(r.x + 40, r.y + 20, { steps: 4 });
    const box = await pg.locator('.ed-stage .wgt[data-id=w13]').boundingBox();
    await pg.screenshot({ path: path.join(OUT, '11-redimensionar.png'), clip: { x: box.x - 60, y: box.y - 80, width: 420, height: 260 } }); console.log('ok 11-redimensionar');
    await pg.mouse.up(); await pg.keyboard.press('Control+z');
  });
  await step('texto na tela', async () => {
    await pg.dblclick('.ed-stage .wgt[data-id=w14]'); await pg.keyboard.press('Control+a'); await pg.keyboard.type('PARADA'); await pg.keyboard.press('Shift+Enter'); await pg.keyboard.type('MOTOR 1');
    const box = await pg.locator('.inline-edit').boundingBox();
    await pg.screenshot({ path: path.join(OUT, '12-texto-na-tela.png'), clip: { x: box.x - 80, y: box.y - 60, width: 440, height: 220 } }); console.log('ok 12-texto-na-tela');
    await pg.keyboard.press('Escape');
  });
  await step('tela props', async () => { await pg.click('.ed-stage', { position: { x: 8, y: 8 } }); await shot('13-propriedades-tela'); });
  await step('paleta botoes de tela', async () => {
    await pg.evaluate(() => document.querySelector('.ed-palette').scrollTop = 9999);
    await pg.click('.pal-nav:has-text("Tendências")'); await shot('14-botao-de-tela');
    await pg.keyboard.press('Delete');
  });
  await step('imagem', async () => {
    await pg.click('.pal-item:has-text("Imagem")'); await shot('15-imagem'); await pg.keyboard.press('Delete');
  });

  // Tags, PLCs, Gateway
  await step('tags', async () => { await pg.click('[data-page=tags]'); await shot('16-tags', { wait: 900 }); });
  await step('plcs', async () => {
    await pg.click('[data-page=connections]'); await pg.waitForTimeout(400);
    await pg.click('text=+ Novo PLC'); await pg.waitForTimeout(300);
    await shot('17-plcs');
  });
  await step('gateway', async () => { await pg.goto(srv.url + '/estacao-1/'); await pg.waitForTimeout(1200); await pg.click('[data-page=gateway]'); await shot('18-gateway', { wait: 1500 }); });
  await step('alarmes cfg', async () => { await pg.click('[data-page=alarms]'); await shot('19-alarmes-config', { wait: 600, s: { fullPage: false } }); });

  // Histórico
  await step('historico', async () => { await pg.click('[data-page=history]'); await shot('20-historico', { wait: 1500 }); });
  await step('historico cfg', async () => { await pg.click('.subtabs >> text=Configuração'); await shot('21-historico-config', { wait: 1500 }); });

  // Usuários
  await step('usuarios', async () => { await pg.click('[data-page=users]'); await shot('22-usuarios', { wait: 900 }); });

  // Produção
  await step('producao', async () => { await pg.click('#modeBox >> text=▶ Produção'); await shot('23-producao-alerta'); await pg.click('.mode-dialog >> text=Cancelar'); });

  // Backup e HTTPS (lista de projetos)
  await pg.goto(srv.url + '/'); await pg.waitForTimeout(900);
  await step('versoes', async () => { await pg.click('.proj-card:has-text("Estação 1") >> text=🕘 Versões salvas'); await shot('24-versoes'); await pg.click('.modal-box >> text=Fechar'); });
  await step('backup auto', async () => { await pg.click('text=⏰ Backup automático'); await shot('25-backup-automatico', { wait: 800 }); await pg.click('.mode-dialog >> text=Fechar'); });
  await step('https', async () => { await pg.click('text=🔒 HTTPS'); await shot('26-https', { wait: 800 }); await pg.click('.mode-dialog >> text=Fechar'); });

  // Celular
  await step('celular', async () => {
    const m = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
    await m.goto(srv.url + '/estacao-1/'); await m.waitForTimeout(1800);
    await m.screenshot({ path: path.join(OUT, '27-celular.png') }); console.log('ok 27-celular');
  });

  await b.close();
  await srv.stop();
})();
