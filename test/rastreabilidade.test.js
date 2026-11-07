'use strict';
// Rastreabilidade com PLC simulado (Modbus TCP): gatilho, gravação, bit de confirmação (handshake),
// nova tentativa quando falta leitura, pesquisa por código/resultado e exportação CSV.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, freePort, waitFor, fakeModbus } = require('./helpers');

let srv, admin, plc;

test.before(async () => {
  const port = await freePort();
  plc = fakeModbus(port);
  srv = await startServer();
  admin = new Client(srv.url);
  await admin.loginAdmin();
  const project = {
    name: 'Linha RFID',
    connections: [{ id: 'plc', name: 'PLC', driver: 'modbus-tcp', host: '127.0.0.1', port, unitId: 1, pollMs: 80, enabled: true }],
    tags: [
      { name: 'Lido', connection: 'plc', address: 'C0', type: 'bool', access: 'RW' },
      { name: 'Gravado', connection: 'plc', address: 'C1', type: 'bool', access: 'RW' },
      { name: 'Codigo', connection: 'plc', address: 'HR0', type: 'int32', access: 'R' },
      { name: 'Tensao', connection: 'plc', address: 'HR10', type: 'int16', access: 'R' },
      { name: 'Resultado', connection: 'plc', address: 'HR20', type: 'int16', access: 'R' },
      { name: 'Passo', connection: 'plc', address: 'HR30', type: 'int16', access: 'R' },
    ],
    trace: {
      defs: [
        { id: 'tf', name: 'Teste final', trigger: 'Lido', keyTag: 'Codigo', ackTag: 'Gravado',
          fields: [{ tag: 'Tensao', label: 'Tensão (V)' }], resultTag: 'Resultado', okValue: 1 },
        { id: 'ps', name: 'Passo', trigger: 'Passo', trigMode: 'change', fields: [{ tag: 'Tensao' }] },
      ],
    },
    screens: [{ id: 't1', name: 'Teste', widgets: [] }],
  };
  const r = await admin.post('/api/projects', { name: 'Linha RFID', project });
  assert.equal(r.body.slug, 'linha-rfid');
  await waitFor(async () => (await admin.get('/linha-rfid/api/values')).body.Lido?.q === 'good', { msg: 'PLC online' });
});

test.after(async () => {
  await srv?.stop();
  await plc?.close();
});

// DINT em dois registradores (word alta primeiro).
const setCode = (n) => { plc.hr[0] = n >>> 16; plc.hr[1] = n & 0xffff; };
const search = async (q = '') => (await admin.get('/linha-rfid/api/trace?' + q)).body;

// Uma peça: PLC escreve dados, liga o gatilho, espera a confirmação e desliga o gatilho.
async function peca(code, tensao, resultado) {
  setCode(code); plc.hr[10] = tensao; plc.hr[20] = resultado;
  await new Promise((r) => setTimeout(r, 200));
  plc.coils[0] = true;
  await waitFor(() => plc.coils[1] === true, { msg: `confirmação da peça ${code}` });
  plc.coils[0] = false;
  await waitFor(() => plc.coils[1] === false, { msg: `confirmação desligada (${code})` });
}

test('Grava a peça e confirma ao PLC (handshake)', async () => {
  await peca(100245, 12, 1);
  await peca(100246, 11, 2);
  const r = await search('def=tf');
  assert.equal(r.total, 2);
  const [b, a] = r.rows;
  assert.equal(a.code, '100245');
  assert.equal(a.result, 1);
  assert.equal(a.data.Tensao, 12);
  assert.equal(b.code, '100246');
  assert.equal(b.result, 0);
  assert.equal(a.user, '', 'sem painel aberto, sem operador');
});

test('Pesquisa por código e por resultado', async () => {
  assert.equal((await search('code=0245')).total, 1);
  assert.equal((await search('def=tf&result=nok')).rows[0].code, '100246');
  assert.equal((await search('def=tf&result=ok')).rows[0].code, '100245');
  assert.equal((await search('code=999')).total, 0);
});

test('Gatilho por mudança de valor (sem confirmação)', async () => {
  plc.hr[30] = 1;
  await waitFor(async () => (await search('def=ps')).total === 1, { msg: 'registro do passo 1' });
  plc.hr[30] = 0; // zero não grava
  await new Promise((r) => setTimeout(r, 300));
  plc.hr[30] = 2;
  await waitFor(async () => (await search('def=ps')).total === 2, { msg: 'registro do passo 2' });
});

test('Exporta CSV para o Excel', async () => {
  const txt = (await admin.get('/linha-rfid/api/trace.csv?def=tf')).text;
  const lines = txt.replace(/^﻿/, '').trim().split('\n');
  assert.equal(lines[0], 'data_hora;registro;codigo;resultado;operador;Tensão (V)');
  assert.match(lines[1], /;Teste final;100245;OK;;12$/);
  assert.match(lines[2], /;100246;NOK;;11$/);
});

test('Sem leitura de um tag: não confirma e grava quando voltar', async () => {
  // Valor que o PLC simulado não consegue devolver: a leitura desses registradores falha.
  plc.hr[10] = 70000;
  await waitFor(async () => (await admin.get('/linha-rfid/api/values')).body.Tensao?.q === 'bad', { msg: 'tensão sem leitura' });
  setCode(100247);
  plc.coils[0] = true;
  await waitFor(async () => (await admin.get('/linha-rfid/api/trace/state')).body.find((d) => d.id === 'tf')?.error, { msg: 'erro informado' });
  assert.equal(plc.coils[1], false, 'não confirma sem gravar');
  assert.equal((await search('code=100247')).total, 0);
  plc.hr[10] = 13;
  await waitFor(() => plc.coils[1] === true, { msg: 'confirmação depois de voltar a leitura' });
  assert.equal((await search('code=100247')).total, 1);
  plc.coils[0] = false;
  await waitFor(() => plc.coils[1] === false, { msg: 'confirmação desligada' });
});
