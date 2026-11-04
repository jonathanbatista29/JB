'use strict';
// Testes de integração com equipamentos simulados: PLC Modbus TCP e multímetro DM858 (SCPI),
// ligados pelo Gateway (medida -> PLC, função pedida pelo PLC -> multímetro, reset por pulso, status online).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, freePort, waitFor, fakeModbus, fakeDmm } = require('./helpers');

let srv, admin, plc, dmm, plcPort, dmmPort;

test.before(async () => {
  plcPort = await freePort();
  dmmPort = await freePort();
  plc = fakeModbus(plcPort);
  dmm = fakeDmm(dmmPort);
  srv = await startServer();
  admin = new Client(srv.url);
  await admin.loginAdmin();
  const funcs = 'FUNC? | CONF:{1=VOLT:DC;2=VOLT:AC;3=CURR:DC}';
  const project = {
    name: 'Bancada',
    connections: [
      { id: 'plc', name: 'PLC', driver: 'modbus-tcp', host: '127.0.0.1', port: plcPort, unitId: 1, pollMs: 100, enabled: true },
      { id: 'dmm', name: 'Multímetro', driver: 'scpi', host: '127.0.0.1', port: dmmPort, timeout: 1500, pollMs: 150, enabled: true },
    ],
    tags: [
      { name: 'DMM_Medida', connection: 'dmm', address: 'READ?', type: 'float32', access: 'R' },
      { name: 'DMM_Funcao', connection: 'dmm', address: funcs, type: 'int16', access: 'RW' },
      { name: 'DMM_Reset', connection: 'dmm', address: '| *RST', type: 'bool', access: 'RW' },
      { name: 'DMM_IDN', connection: 'dmm', address: '*IDN?', type: 'string', access: 'R' },
      { name: 'PLC_Funcao', connection: 'plc', address: 'HR40', type: 'int16', access: 'RW' },
      { name: 'PLC_VDC', connection: 'plc', address: 'HR50', type: 'float32', access: 'RW' },
      { name: 'PLC_VAC', connection: 'plc', address: 'HR52', type: 'float32', access: 'RW' },
      { name: 'PLC_mV', connection: 'plc', address: 'HR60', type: 'int32', access: 'RW' },
      { name: 'PLC_Reset', connection: 'plc', address: 'C10', type: 'bool', access: 'RW' },
      { name: 'PLC_Online', connection: 'plc', address: 'C11', type: 'bool', access: 'RW' },
      { name: 'PLC_Bit', connection: 'plc', address: 'HR70.3', type: 'bool', access: 'RW' },
    ],
    gateway: [
      { id: 'f', source: 'PLC_Funcao', target: 'DMM_Funcao', mode: 'change' },
      { id: 'vdc', source: 'DMM_Medida', target: 'PLC_VDC', mode: 'change', condTag: 'DMM_Funcao', condValue: 1 },
      { id: 'vac', source: 'DMM_Medida', target: 'PLC_VAC', mode: 'change', condTag: 'DMM_Funcao', condValue: 2 },
      { id: 'mv', source: 'DMM_Medida', target: 'PLC_mV', mode: 'change', gain: 1000 },
      { id: 'rst', source: 'PLC_Reset', target: 'DMM_Reset', mode: 'pulse', resetSource: true },
      { id: 'on', source: '@status:dmm', target: 'PLC_Online', mode: 'change' },
    ],
    screens: [{ id: 't1', name: 'Teste', widgets: [] }],
  };
  const r = await admin.post('/api/projects', { name: 'Bancada', project });
  assert.equal(r.body.slug, 'bancada');
});

test.after(async () => {
  await srv?.stop();
  await plc?.close();
  await dmm?.close();
});

const values = async () => (await admin.get('/bancada/api/values')).body;

test('Lê o multímetro (identificação e medida) e escreve no PLC', async () => {
  await waitFor(async () => (await values()).DMM_IDN?.v?.includes('DM858E'), { msg: 'identificação do multímetro' });
  await waitFor(() => Math.abs(plc.f32(50) - 12) < 0.01, { msg: 'tensão DC no PLC' });
  await waitFor(() => plc.hr[60] * 65536 + plc.hr[61] === 12000, { msg: 'medida em mV (INT 32)' });
  assert.equal(plc.coils[11], true, 'PLC sabe que o multímetro está online');
});

test('PLC troca a função e cada medida vai para a sua memória', async () => {
  plc.hr[40] = 2; // PLC pede tensão AC
  await waitFor(() => dmm.state.func === 'VOLT:AC', { msg: 'multímetro mudar para VOLT:AC' });
  await waitFor(() => Math.abs(plc.f32(52) - 220) < 0.01, { msg: 'tensão AC no PLC' });
  assert.ok(Math.abs(plc.f32(50) - 12) < 0.01, 'memória de tensão DC guarda o último valor');
  await waitFor(async () => (await values()).DMM_Funcao?.v === 2, { msg: 'função lida do multímetro = 2' });
});

test('Bit de reset do PLC envia *RST e é desligado', async () => {
  plc.coils[10] = true;
  await waitFor(() => dmm.state.commands.includes('*RST'), { msg: '*RST no multímetro' });
  await waitFor(() => plc.coils[10] === false, { msg: 'bit de reset desligado' });
});

test('Escrita direta em tags Modbus (bit dentro de registrador)', async () => {
  plc.hr[70] = 0b0001;
  assert.equal((await admin.post('/bancada/api/write', { tag: 'PLC_Bit', value: true })).status, 200);
  await waitFor(() => plc.hr[70] === 0b1001, { msg: 'bit 3 ligado sem mexer nos outros' });
});

test('Sobrecarga e queda do multímetro', async () => {
  dmm.state.overload = true;
  await waitFor(async () => (await values()).DMM_Medida?.q === 'bad', { msg: 'sobrecarga com qualidade ruim' });
  dmm.state.overload = false;
  await dmm.close();
  await waitFor(() => plc.coils[11] === false, { timeout: 12000, msg: 'PLC saber que o multímetro caiu' });
  dmm = fakeDmm(dmmPort);
  await waitFor(() => plc.coils[11] === true, { timeout: 12000, msg: 'reconexão do multímetro' });
});
