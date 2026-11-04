'use strict';
const { coerce } = require('../util');

// Driver de simulação: permite montar e testar telas sem nenhum PLC conectado.
// Endereços aceitos:
//   sine:amplitude:periodo:offset   senoide
//   ramp:max:periodo                rampa 0..max
//   random:min:max                  valor aleatório
//   square:periodo                  liga/desliga
//   qualquer outro texto            memória (lê o que foi escrito)
class SimulatorDriver {
  constructor() {
    this.mem = new Map();
    this.t0 = Date.now();
  }

  async connect() {}
  async disconnect() {}

  async read(tags) {
    const t = (Date.now() - this.t0) / 1000;
    const values = {};
    for (const tag of tags) values[tag.name] = this.valueOf(tag, t);
    return { values, errors: {} };
  }

  valueOf(tag, t) {
    const addr = String(tag.address || tag.name).trim();
    const [fn, ...rest] = addr.split(':');
    const n = rest.map(Number);
    const num = (i, d) => (Number.isFinite(n[i]) ? n[i] : d);
    switch (fn.toLowerCase()) {
      case 'sine': {
        const amp = num(0, 50), per = num(1, 10), off = num(2, amp);
        return round(off + amp * Math.sin((2 * Math.PI * t) / per), tag.type);
      }
      case 'ramp': {
        const max = num(0, 100), per = num(1, 20);
        return round(((t % per) / per) * max, tag.type);
      }
      case 'random': {
        const min = num(0, 0), max = num(1, 100);
        return round(min + Math.random() * (max - min), tag.type);
      }
      case 'square': {
        const per = num(0, 2);
        const on = Math.floor(t / (per / 2)) % 2 === 0;
        return tag.type === 'bool' ? on : on ? 1 : 0;
      }
      default: {
        if (!this.mem.has(addr)) this.mem.set(addr, tag.type === 'bool' ? false : tag.type === 'string' ? '' : 0);
        return this.mem.get(addr);
      }
    }
  }

  async write(tag, value) {
    const addr = String(tag.address || tag.name).trim();
    this.mem.set(addr, coerce(value, tag.type));
  }
}

function round(v, type) {
  if (type === 'bool') return v > 0;
  if (type && type !== 'float32') return Math.round(v);
  return Math.round(v * 100) / 100;
}

module.exports = SimulatorDriver;
