'use strict';

const DRIVERS = {
  simulator: () => require('./simulator'),
  'modbus-tcp': () => require('./modbus'),
  'modbus-rtu': () => require('./modbus'),
  s7: () => require('./s7'),
};

function createDriver(cfg) {
  const load = DRIVERS[cfg.driver];
  if (!load) throw new Error(`Driver desconhecido: ${cfg.driver}`);
  const Driver = load();
  return new Driver(cfg);
}

module.exports = { createDriver, DRIVER_NAMES: Object.keys(DRIVERS) };
