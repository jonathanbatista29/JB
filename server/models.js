'use strict';

// Modelos de PLC pré-configurados. Cada modelo escolhe o driver e os parâmetros padrão.
module.exports = [
  { id: 'sim', vendor: 'JB', name: 'Simulador (sem PLC)', driver: 'simulator', defaults: {},
    notes: 'Gera valores de teste. Endereços: sine:amplitude:período, ramp:max:período, random:min:max, square:período ou qualquer nome (memória).' },

  { id: 's7-1200', vendor: 'Siemens', name: 'S7-1200', driver: 's7', defaults: { port: 102, rack: 0, slot: 1 },
    notes: 'Habilite "Permit PUT/GET" no TIA Portal e desative "Optimized block access" nos DBs usados.' },
  { id: 's7-1500', vendor: 'Siemens', name: 'S7-1500', driver: 's7', defaults: { port: 102, rack: 0, slot: 1 },
    notes: 'Habilite "Permit PUT/GET" e desative "Optimized block access" nos DBs usados.' },
  { id: 's7-300', vendor: 'Siemens', name: 'S7-300', driver: 's7', defaults: { port: 102, rack: 0, slot: 2 },
    notes: 'CPU normalmente no rack 0, slot 2.' },
  { id: 's7-400', vendor: 'Siemens', name: 'S7-400', driver: 's7', defaults: { port: 102, rack: 0, slot: 3 },
    notes: 'Verifique o slot da CPU na configuração de hardware.' },
  { id: 'logo8', vendor: 'Siemens', name: 'LOGO! 8 (Modbus TCP)', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 },
    notes: 'Ative o servidor Modbus TCP no LOGO! Soft Comfort (versão 8.FS4 ou superior).' },

  { id: 'schneider-m221', vendor: 'Schneider', name: 'Modicon M221 / M241 / M251', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 },
    notes: '%MW = Holding Registers (HR), %M = Coils (C).' },
  { id: 'weg-clic', vendor: 'WEG', name: 'CLIC02 / TPW-03 (Modbus TCP)', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 }, notes: '' },
  { id: 'weg-rtu', vendor: 'WEG', name: 'CLIC02 / TPW / Inversores (Modbus RTU)', driver: 'modbus-rtu', defaults: { baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1, unitId: 1 }, notes: '' },
  { id: 'delta-dvp', vendor: 'Delta', name: 'DVP / AS (Modbus TCP)', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 },
    notes: 'D0 = HR4096, M0 = C2048 (consulte o manual do modelo).' },
  { id: 'ab-micro800', vendor: 'Allen-Bradley', name: 'Micro800 (Modbus TCP)', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 },
    notes: 'Mapeie as variáveis na tabela Modbus no Connected Components Workbench.' },
  { id: 'mitsubishi-fx5', vendor: 'Mitsubishi', name: 'FX5U / iQ-R (Modbus TCP)', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 },
    notes: 'Ative a função Modbus/TCP no GX Works3.' },
  { id: 'altus-nexto', vendor: 'Altus', name: 'Nexto / Hadron (Modbus TCP)', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 }, notes: '' },

  { id: 'modbus-tcp', vendor: 'Genérico', name: 'Modbus TCP', driver: 'modbus-tcp', defaults: { port: 502, unitId: 1 }, notes: '' },
  { id: 'modbus-rtu', vendor: 'Genérico', name: 'Modbus RTU (serial RS-485)', driver: 'modbus-rtu', defaults: { baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1, unitId: 1 }, notes: '' },
];
