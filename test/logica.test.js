'use strict';
// Testes de unidade da lógica: projeto, gateway, troca de tela, alarmes, histórico, imagens e backup.
const path = require('path');
const fs = require('fs');
const { tmpDir, sleep, waitFor } = require('./helpers');
process.env.DATA_DIR = tmpDir(); // antes de carregar os módulos que usam a pasta de dados

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const storage = require('../server/storage');
const images = require('../server/images');
const { slugify } = require('../server/projects');
const { Gateway } = require('../server/gateway');
const { Navigator } = require('../server/navigator');
const { Historian } = require('../server/historian');
const { TagManager } = require('../server/tagManager');
const { AutoBackup } = require('../server/autobackup');

// TagManager falso: guarda valores e registra as escritas.
function fakeTm(values = {}, status = {}) {
  const tm = new EventEmitter();
  tm.values = values;
  tm.status = status;
  tm.writes = [];
  tm.write = async (tag, v) => { tm.writes.push([tag, v]); tm.values[tag] = { v, q: 'good' }; };
  return tm;
}
const val = (v) => ({ v, q: 'good', ts: Date.now() });

test('Projeto: normalize preenche padrões e valida números', () => {
  const p = storage.normalize({ screens: [{ id: 'a' }, { id: 'b', number: 5 }, { id: 'c' }], tags: [{ name: 'X' }] });
  assert.deepEqual(p.screens.map((s) => s.number), [1, 5, 2]);
  assert.equal(p.startScreen, 'a');
  assert.deepEqual(p.historian, { retentionDays: 90, heartbeatSec: 60 });
  assert.ok(Array.isArray(p.gateway) && Array.isArray(p.navButtons) && Array.isArray(p.alarms));
  assert.throws(() => storage.normalize({ screens: [{ id: 'a', number: 1 }, { id: 'b', number: 1 }], tags: [] }), /repetido/);
  assert.throws(() => storage.normalize({ screens: [], tags: [{ name: 'A' }, { name: 'A' }] }), /repetido/);
  assert.equal(storage.normalize({}).screens.length, 1, 'cria uma tela se não houver nenhuma');
});

test('Projeto: salvar guarda a versão anterior e restaura', () => {
  const dir = path.join(tmpDir(), 'proj');
  storage.save(dir, { name: 'V1', screens: [], tags: [] }, { keepVersion: false });
  storage.save(dir, { name: 'V2', screens: [], tags: [] });
  const v = storage.listVersions(dir);
  assert.equal(v.length, 1);
  assert.equal(storage.loadVersion(dir, v[0].file).name, 'V1');
  assert.equal(storage.load(dir).name, 'V2');
  assert.throws(() => storage.loadVersion(dir, '../../etc/passwd'), /inválida/);
});

test('Endereço do projeto a partir do nome', () => {
  assert.equal(slugify('Estação 1'), 'estacao-1');
  assert.equal(slugify('  Linha  B / Forno #2 '), 'linha-b-forno-2');
  assert.equal(slugify('***'), 'projeto');
});

test('Imagens: aceita PNG, recusa SVG com script e formatos desconhecidos', () => {
  const dir = tmpDir();
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const f = images.save(dir, { name: 'Máquina Ligada.PNG', data: png });
  assert.equal(f, 'maquina-ligada.png');
  assert.notEqual(images.save(dir, { name: 'Máquina Ligada.png', data: png }), f, 'não sobrescreve outra imagem');
  assert.equal(images.save(dir, { file: 'maquina-ligada.png', data: png }), 'maquina-ligada.png', 'restauração mantém o nome');
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64');
  assert.throws(() => images.save(dir, { name: 'x.svg', data: svg }), /scripts/);
  assert.throws(() => images.save(dir, { name: 'x.exe', data: 'data:application/x-msdownload;base64,AAAA' }), /Formato/);
  assert.equal(images.filePath(dir, '../segredo.png'), null);
  const exp = images.exportAll(dir);
  const dir2 = tmpDir();
  assert.equal(images.importAll(dir2, exp), Object.keys(exp).length);
  const used = images.usedBy({ screens: [{ bgImage: 'fundo.png', widgets: [{ type: 'image', props: { src: 'a.png', srcOn: 'b.png' } }] }] });
  assert.deepEqual([...used].sort(), ['a.png', 'b.png', 'fundo.png']);
});

test('Gateway: copia com ganho, comando por pulso e status da conexão', async () => {
  const tm = fakeTm({ Medida: val(1.5), Reset: val(false) }, { dmm: { state: 'online' } });
  const project = { tags: [{ name: 'PLC_mV', connection: 'plc' }, { name: 'DMM_Reset', connection: 'dmm' }, { name: 'PLC_Online', connection: 'plc' }],
    gateway: [
      { id: 'g1', source: 'Medida', target: 'PLC_mV', mode: 'change', gain: 1000, offset: 0 },
      { id: 'g2', source: 'Reset', target: 'DMM_Reset', mode: 'pulse', resetSource: true },
      { id: 'g3', source: '@status:dmm', target: 'PLC_Online', mode: 'change', gain: 1 },
    ] };
  const gw = new Gateway(tm);
  gw.configure(project);
  gw.onValues({ Medida: val(2.25) });
  await sleep(10);
  assert.deepEqual(tm.writes.at(-1), ['PLC_mV', 2250]);
  gw.onValues({ Medida: val(2.25) }); // mesmo valor: não escreve de novo
  await sleep(10);
  assert.equal(tm.writes.filter((w) => w[0] === 'PLC_mV').length, 1);
  gw.onValues({ Reset: val(true) });
  await sleep(10);
  assert.ok(tm.writes.some((w) => w[0] === 'DMM_Reset' && w[1] === true), 'pulso envia o comando');
  assert.ok(tm.writes.some((w) => w[0] === 'Reset' && w[1] === false), 'pulso desliga a origem');
  gw.onStatus({ dmm: { state: 'online' } });
  await sleep(10);
  assert.ok(tm.writes.some((w) => w[0] === 'PLC_Online' && w[1] === 1));
});

test('Gateway: "só quando" separa cada função numa memória e não copia medida antiga', async () => {
  const tm = fakeTm({ Func: val(1), Medida: val(12) });
  const gw = new Gateway(tm);
  gw.configure({ tags: [], gateway: [
    { id: 'vdc', source: 'Medida', target: 'PLC_VDC', mode: 'change', gain: 1, condTag: 'Func', condValue: 1 },
    { id: 'vac', source: 'Medida', target: 'PLC_VAC', mode: 'change', gain: 1, condTag: 'Func', condValue: 2 },
  ] });
  gw.onValues({ Medida: val(12) });
  await sleep(10);
  assert.deepEqual(tm.writes, [['PLC_VDC', 12]]);
  // a função muda, mas a medida ainda é a antiga: nada vai para a memória de VAC
  tm.values.Func = val(2);
  gw.onValues({ Func: val(2) });
  await sleep(10);
  assert.equal(tm.writes.length, 1);
  tm.values.Medida = val(220);
  gw.onValues({ Medida: val(220) });
  await sleep(10);
  assert.deepEqual(tm.writes.at(-1), ['PLC_VAC', 220]);
  assert.equal(tm.writes.filter((w) => w[0] === 'PLC_VDC').length, 1, 'memória de VDC guarda o último valor');
});

test('Troca de tela pelo PLC: por número, por bit e tela atual', async () => {
  const tm = fakeTm();
  const nav = new Navigator(tm);
  const events = [];
  nav.on('navigate', (e) => events.push(e.screen));
  nav.configure({ navigation: { requestTag: 'Req', resetRequest: true, currentTag: 'Atual' },
    screens: [{ id: 't1', number: 1 }, { id: 't2', number: 2, openTag: 'Abrir2', resetOpenTag: true }] });
  nav.onValues({ Req: val(2) });
  nav.onValues({ Req: val(99) }); // tela inexistente: ignora
  nav.onValues({ Abrir2: val(true) });
  nav.onValues({ Abrir2: val(true) }); // continua ligado: não repete
  await sleep(10);
  assert.deepEqual(events, ['t2', 't2']);
  assert.ok(tm.writes.some((w) => w[0] === 'Req' && w[1] === 0), 'zera o pedido');
  assert.ok(tm.writes.some((w) => w[0] === 'Abrir2' && w[1] === false), 'desliga o bit');
  nav.reportScreen('t1');
  await sleep(10);
  assert.deepEqual(tm.writes.at(-1), ['Atual', 1]);
});

test('Comunicação e alarmes com o simulador', async () => {
  const tm = new TagManager();
  await tm.load({
    connections: [{ id: 'sim', driver: 'simulator', pollMs: 50 }],
    tags: [{ name: 'Nivel', connection: 'sim', address: 'mem', type: 'float32', access: 'RW' }, { name: 'Leitura', connection: 'sim', address: 'x', type: 'int16', access: 'R' }],
    alarms: [{ id: 'a1', tag: 'Nivel', condition: '>', limit: 80, message: 'Nível alto', priority: 'alta' }],
  });
  try {
    await waitFor(() => tm.status.sim?.state === 'online', { msg: 'simulador online' });
    await tm.write('Nivel', 90);
    await waitFor(() => tm.alarmState().active.length === 1, { msg: 'alarme ativo' });
    tm.ack('a1', 'teste');
    assert.equal(tm.alarmState().active[0].acked, true);
    await tm.write('Nivel', 10);
    await waitFor(() => tm.alarmState().active.length === 0, { msg: 'alarme normalizado' });
    assert.deepEqual(tm.history.map((e) => e.event).reverse(), ['ATIVO', 'RECONHECIDO', 'NORMAL']);
    await assert.rejects(() => tm.write('Leitura', 1), /somente leitura/);
    await assert.rejects(() => tm.write('NaoExiste', 1), /não encontrado/);
  } finally {
    await tm.stopAll();
  }
});

test('Histórico: grava por mudança com banda morta e agrupa no gráfico', () => {
  const h = new Historian(path.join(tmpDir(), 'h.db'));
  try {
    h.configure({ tags: [{ name: 'T', type: 'float32', log: true, logDeadband: 0.5 }, { name: 'X', type: 'float32' }], historian: { heartbeatSec: 3600 } });
    const t0 = Date.now() - 10000;
    const vals = [10, 10.2, 10.4, 11, 11.1, 12];
    vals.forEach((v, i) => h.onValues({ T: { v, q: 'good', ts: t0 + i * 1000 }, X: { v, q: 'good', ts: t0 } }));
    const raw = h.raw(['T', 'X'], t0 - 1, Date.now());
    assert.deepEqual(raw.map((r) => r.v), [10, 11, 12], 'só grava variações maiores que 0,5; X não é registrado');
    const s = h.series(['T'], t0 - 1, t0 + 6000, 10);
    assert.ok(s.series.T.length >= 2 && s.series.T.length <= 12);
    h.addAlarm({ ts: Date.now(), event: 'ATIVO', message: 'Teste', tag: 'T', value: 12, priority: 'alta' });
    assert.equal(h.alarms({ text: 'Teste' }).length, 1);
  } finally {
    h.close();
  }
});

test('Backup automático: horário, quantidade de cópias e pasta inválida', async () => {
  const ab = new AutoBackup({ runtimes: new Map() });
  assert.throws(() => ab.update({ time: '25:00' }), /Horário/);
  assert.throws(() => ab.update({ keep: 0 }), /cópias/);
  if (process.platform === 'linux') assert.throws(() => ab.update({ folder: '/proc/nao-pode' }), /Não foi possível gravar/);
  const dest = path.join(tmpDir(), 'bk', 'sub');
  const s = ab.update({ enabled: true, time: '00:00', keep: 2, folder: dest, includeHistory: false });
  assert.equal(s.folderPath, dest);
  for (let i = 0; i < 3; i++) { await ab.run('teste'); await sleep(1100); }
  const list = ab.list();
  assert.equal(list.length, 2, 'mantém só as 2 cópias mais novas');
  assert.ok(fs.existsSync(path.join(dest, list[0].name, 'backup-geral.json')));
  assert.equal(new Date(ab.nextRun()).getDate(), new Date(Date.now() + 86400000).getDate(), 'já rodou hoje: próximo é amanhã');
});
