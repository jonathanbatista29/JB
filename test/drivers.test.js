'use strict';
// Testes de unidade: endereços e conversões dos drivers Modbus e SCPI, e conversão de tipos.
const test = require('node:test');
const assert = require('node:assert/strict');
const modbus = require('../server/drivers/modbus');
const Scpi = require('../server/drivers/scpi');
const { coerce } = require('../server/util');

test('Modbus: endereços curtos (base 0) e clássicos (base 1)', () => {
  assert.deepEqual(modbus.parseAddress('HR10'), { area: 'hr', index: 10, bit: null });
  assert.deepEqual(modbus.parseAddress('hr10.3'), { area: 'hr', index: 10, bit: 3 });
  assert.deepEqual(modbus.parseAddress('C5'), { area: 'coil', index: 5, bit: null });
  assert.deepEqual(modbus.parseAddress('DI0'), { area: 'di', index: 0, bit: null });
  assert.deepEqual(modbus.parseAddress('IR7'), { area: 'ir', index: 7, bit: null });
  assert.deepEqual(modbus.parseAddress('40001'), { area: 'hr', index: 0, bit: null });
  assert.deepEqual(modbus.parseAddress('30021'), { area: 'ir', index: 20, bit: null });
  assert.deepEqual(modbus.parseAddress('00011'), { area: 'coil', index: 10, bit: null });
  assert.throws(() => modbus.parseAddress('XX'), /inválido/);
  assert.throws(() => modbus.parseAddress('40000'), /inválido/);
});

test('Modbus: codifica e decodifica INT, UINT, DINT, REAL e bits', () => {
  for (const [type, v] of [['int16', -500], ['uint16', 65000], ['int32', -123456], ['uint32', 4000000000], ['float32', 12.5]]) {
    for (const swap of [false, true]) {
      const regs = modbus.encode(v, type, swap);
      assert.equal(modbus.decode(regs, type, null, swap), v, `${type} swap=${swap}`);
    }
  }
  assert.equal(modbus.decode([0b1000], 'bool', 3, false), true);
  assert.equal(modbus.decode([0b1000], 'bool', 2, false), false);
  // REAL 12.5 em ordem normal = 0x4148 0x0000; com troca de words fica invertido
  assert.deepEqual(modbus.encode(12.5, 'float32', false), [0x4148, 0]);
  assert.deepEqual(modbus.encode(12.5, 'float32', true), [0, 0x4148]);
});

test('SCPI: endereço com consulta, comando e tabela de funções', () => {
  const a = Scpi.parseAddress('FUNC? | CONF:{1=VOLT:DC;2=VOLT:AC;3=CURR:DC}');
  assert.equal(a.read, 'FUNC?');
  assert.equal(a.write, 'CONF:{1=VOLT:DC;2=VOLT:AC;3=CURR:DC}');
  assert.deepEqual(a.map, [[1, 'VOLT:DC'], [2, 'VOLT:AC'], [3, 'CURR:DC']]);
  assert.deepEqual(Scpi.parseAddress('READ?'), { read: 'READ?', write: '', map: null });
  assert.deepEqual(Scpi.parseAddress('| *RST'), { read: '', write: '*RST', map: null });
});

test('SCPI: respostas do DM858 viram o número da função (forma curta e longa)', () => {
  const d = new Scpi({});
  const map = Scpi.parseAddress('FUNC? | CONF:{1=VOLT:DC;2=VOLT:AC;3=CURR:DC;4=CURR:AC;5=RES;6=FREQ;7=CAP;8=FRES}').map;
  const t = { type: 'int16' };
  const casos = { '"VOLT"': 1, '"VOLT:AC"': 2, '"CURR"': 3, '"CURR:AC"': 4, '"RES"': 5, '"FREQ"': 6, '"CAP"': 7, '"FRES"': 8,
    'VOLT:AC 1.00000000E+01,1.0E-03': 2, '"VOLTage:DC"': 1, '"CURRent:AC"': 4 };
  for (const [resp, n] of Object.entries(casos)) assert.equal(d.parse(resp, t, map), n, resp);
  assert.equal(Scpi.funcKey('VOLTage:DC'), 'VOLT');
  assert.equal(Scpi.funcKey('"FRESistance"'), 'FRES');
});

test('SCPI: medidas, várias amostras e sobrecarga (OL)', () => {
  const d = new Scpi({});
  assert.equal(d.parse('+1.23450000E+01', { type: 'float32' }), 12.345);
  assert.equal(d.parse('-4.98748741E-01,-4.35163427E-01', { type: 'float32' }), -0.498748741);
  assert.equal(d.parse('9.90000000E+37', { type: 'float32' }), undefined);
  assert.equal(d.parse('1', { type: 'bool' }), true);
  assert.equal(d.parse('ON', { type: 'bool' }), true);
  assert.equal(d.parse('RIGOL,DM858E', { type: 'string' }), 'RIGOL,DM858E');
  assert.throws(() => d.parse('ERRO', { type: 'float32' }), /não numérica/);
});

test('SCPI: escrita monta o comando certo', async () => {
  const d = new Scpi({});
  const sent = [];
  d.send = (c) => sent.push(c);
  const func = { name: 'f', address: 'FUNC? | CONF:{1=VOLT:DC;2=VOLT:AC}', type: 'int16' };
  await d.write(func, 2);
  await d.write(func, 0); // 0 = nenhum pedido: não envia nada
  await assert.rejects(() => d.write(func, 9), /tabela/);
  await d.write({ name: 'r', address: '| *RST', type: 'bool' }, true);
  await d.write({ name: 'r', address: '| *RST', type: 'bool' }, false); // comando de ação só ao ligar
  await d.write({ name: 'n', address: 'SAMP:COUN? | SAMP:COUN {v}', type: 'int16' }, 5);
  await d.write({ name: 'b', address: 'X? | CALC:STAT {v}', type: 'bool' }, true);
  assert.deepEqual(sent, ['CONF:VOLT:AC', '*RST', 'SAMP:COUN 5', 'CALC:STAT ON']);
  await assert.rejects(() => d.write({ name: 'm', address: 'READ?', type: 'float32' }, 1), /escrita/);
});

test('Conversão de valores para o tipo do tag', () => {
  assert.equal(coerce('true', 'bool'), true);
  assert.equal(coerce('0', 'bool'), false);
  assert.equal(coerce(1, 'bool'), true);
  assert.equal(coerce(40000, 'int16'), 32767);
  assert.equal(coerce(-5, 'uint16'), 0);
  assert.equal(coerce(2.6, 'int32'), 3);
  assert.equal(coerce('1.5', 'float32'), 1.5);
  assert.equal(coerce(12, 'string'), '12');
  assert.throws(() => coerce('abc', 'int16'), /inválido/);
});

test('CompactLogix: lista de tags do PLC para importar (UDT, STRING, array e programa)', () => {
  const { browseTagList } = require('../server/drivers/logix');
  const T = (typeName, extra = {}) => ({ typeName, structure: false, arrayDims: 0, reserved: false, ...extra });
  const tags = [
    { name: 'teste_ihm', program: null, type: T('DINT') },
    { name: 'Motor_Run', program: null, type: T('BOOL') },
    { name: 'Receita', program: null, type: T('REAL', { arrayDims: 1 }) },
    { name: 'Nivel', program: 'MainProgram', type: T('REAL') },
    { name: 'TESTE_RFID', program: null, type: { typeName: 'UDT', code: 300, structure: true, arrayDims: 0, reserved: false } },
    { name: 'Operador', program: null, type: { typeName: 'STRING', code: 400, structure: true, arrayDims: 0, reserved: false } },
    { name: '__interno', program: null, type: T('DINT') },
    { name: 'Map:Local', program: null, type: T('DINT', { reserved: true }) },
  ];
  const M = (name, string, extra = {}) => ({ name, type: { code: 0, string, structure: false, reserved: false, arrayDims: 0, ...extra } });
  const templates = {
    300: { _name: 'RFID_UDT', _members: [M('ZZZZZZZZZZRFID0', 'SINT'), M('Lido', 'BOOL'), M('Codigo', 'DINT'), M('Texto', '', { code: 400, structure: true })] },
    400: { _name: 'STRING', _members: [M('LEN', 'DINT'), M('DATA', 'SINT', { arrayDims: 1 })] },
  };
  const list = browseTagList(tags, templates);
  const by = Object.fromEntries(list.map((x) => [x.address, x]));
  assert.equal(by.teste_ihm.type, 'int32');
  assert.equal(by.Motor_Run.type, 'bool');
  assert.equal(by['Receita[0]'].type, 'float32');
  assert.equal(by['Receita[0]'].array, true);
  assert.equal(by['Program:MainProgram.Nivel'].program, 'MainProgram');
  assert.equal(by['TESTE_RFID.Lido'].type, 'bool');
  assert.equal(by['TESTE_RFID.Codigo'].type, 'int32');
  assert.equal(by['TESTE_RFID.Texto'].type, 'string');
  assert.equal(by.Operador.type, 'string');
  assert.ok(!Object.keys(by).some((a) => /ZZZZ|__interno|Map:/.test(a)), 'esconde bits internos, tags reservados e de sistema');
});
