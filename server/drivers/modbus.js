'use strict';
const { coerce } = require('../util');

// Driver Modbus TCP e RTU (serial).
// Formatos de endereço (base 0):
//   C10    coil 10            (leitura/escrita, bool)
//   DI10   discrete input 10  (somente leitura, bool)
//   HR10   holding register   (leitura/escrita)
//   IR10   input register     (somente leitura)
//   HR10.3 bit 3 do holding register 10
// Formato clássico (base 1) também é aceito: 00001, 10001, 30001, 40001.

const AREAS = { C: 'coil', CO: 'coil', DI: 'di', HR: 'hr', IR: 'ir' };
const MAX_BLOCK = { coil: 1000, di: 1000, hr: 100, ir: 100 };

function parseAddress(raw) {
  const s = String(raw || '').trim().toUpperCase();
  let m = s.match(/^(CO|C|DI|HR|IR)\s*(\d+)(?:\.(\d+))?$/);
  if (m) return { area: AREAS[m[1]], index: Number(m[2]), bit: m[3] != null ? Number(m[3]) : null };
  m = s.match(/^([0134])(\d{4,5})(?:\.(\d+))?$/);
  if (m) {
    const area = { 0: 'coil', 1: 'di', 3: 'ir', 4: 'hr' }[m[1]];
    const index = Number(m[2]) - 1;
    if (index < 0) throw new Error(`Endereço inválido: ${raw}`);
    return { area, index, bit: m[3] != null ? Number(m[3]) : null };
  }
  throw new Error(`Endereço Modbus inválido: "${raw}" (use C0, DI0, HR0, IR0 ou 40001)`);
}

function regCount(type) {
  return ['int32', 'uint32', 'float32'].includes(type) ? 2 : 1;
}

function decode(regs, type, bit, swap) {
  if (bit != null) return Boolean((regs[0] >> bit) & 1);
  const buf = Buffer.alloc(4);
  if (regCount(type) === 2) {
    const [hi, lo] = swap ? [regs[1], regs[0]] : [regs[0], regs[1]];
    buf.writeUInt16BE(hi, 0);
    buf.writeUInt16BE(lo, 2);
    if (type === 'float32') return Math.round(buf.readFloatBE(0) * 1e4) / 1e4;
    if (type === 'int32') return buf.readInt32BE(0);
    return buf.readUInt32BE(0);
  }
  buf.writeUInt16BE(regs[0], 0);
  if (type === 'int16') return buf.readInt16BE(0);
  if (type === 'bool') return regs[0] !== 0;
  return buf.readUInt16BE(0);
}

function encode(value, type, swap) {
  const buf = Buffer.alloc(4);
  if (regCount(type) === 2) {
    if (type === 'float32') buf.writeFloatBE(value, 0);
    else if (type === 'int32') buf.writeInt32BE(value, 0);
    else buf.writeUInt32BE(value, 0);
    const hi = buf.readUInt16BE(0), lo = buf.readUInt16BE(2);
    return swap ? [lo, hi] : [hi, lo];
  }
  if (type === 'bool') return [value ? 1 : 0];
  if (type === 'int16') buf.writeInt16BE(value, 0);
  else buf.writeUInt16BE(value, 0);
  return [buf.readUInt16BE(0)];
}

class ModbusDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = null;
  }

  async connect() {
    const ModbusRTU = require('modbus-serial');
    const c = new ModbusRTU();
    const cfg = this.cfg;
    if (cfg.driver === 'modbus-rtu') {
      if (!cfg.serialPort) throw new Error('Informe a porta serial (ex.: /dev/ttyUSB0 ou COM3)');
      await c.connectRTUBuffered(cfg.serialPort, {
        baudRate: Number(cfg.baudRate) || 9600,
        parity: cfg.parity || 'none',
        dataBits: Number(cfg.dataBits) || 8,
        stopBits: Number(cfg.stopBits) || 1,
      });
    } else {
      if (!cfg.host) throw new Error('Informe o IP do PLC');
      await c.connectTCP(cfg.host, { port: Number(cfg.port) || 502 });
    }
    c.setID(Number(cfg.unitId) || 1);
    c.setTimeout(Number(cfg.timeout) || 2000);
    this.client = c;
  }

  async disconnect() {
    const c = this.client;
    this.client = null;
    if (c && c.isOpen) await new Promise((r) => c.close(() => r()));
  }

  ensureOpen() {
    if (!this.client || !this.client.isOpen) throw new Error('Conexão perdida');
  }

  // Agrupa tags com endereços próximos em blocos para ler tudo com poucas requisições.
  async read(tags) {
    this.ensureOpen();
    const values = {}, errors = {};
    const items = [];
    for (const tag of tags) {
      try {
        const p = parseAddress(tag.address);
        const len = p.area === 'coil' || p.area === 'di' || p.bit != null ? 1 : regCount(tag.type);
        items.push({ tag, ...p, len });
      } catch (e) {
        errors[tag.name] = e.message;
      }
    }

    for (const area of ['coil', 'di', 'hr', 'ir']) {
      const list = items.filter((i) => i.area === area).sort((a, b) => a.index - b.index);
      const blocks = [];
      for (const it of list) {
        const b = blocks[blocks.length - 1];
        const end = it.index + it.len;
        if (b && it.index - b.end <= 8 && end - b.start <= MAX_BLOCK[area]) {
          b.end = Math.max(b.end, end);
          b.items.push(it);
        } else {
          blocks.push({ start: it.index, end, items: [it] });
        }
      }
      for (const b of blocks) {
        try {
          const data = await this.readBlock(area, b.start, b.end - b.start);
          for (const it of b.items) {
            const off = it.index - b.start;
            if (area === 'coil' || area === 'di') values[it.tag.name] = Boolean(data[off]);
            else values[it.tag.name] = decode(data.slice(off, off + it.len), it.tag.type, it.bit, this.cfg.wordSwap);
          }
        } catch (e) {
          this.ensureOpen();
          for (const it of b.items) errors[it.tag.name] = e.message;
        }
      }
    }
    return { values, errors };
  }

  async readBlock(area, start, len) {
    const c = this.client;
    const fn = { coil: 'readCoils', di: 'readDiscreteInputs', hr: 'readHoldingRegisters', ir: 'readInputRegisters' }[area];
    const res = await c[fn](start, len);
    return res.data;
  }

  async write(tag, value) {
    this.ensureOpen();
    const c = this.client;
    const p = parseAddress(tag.address);
    if (p.area === 'di' || p.area === 'ir') throw new Error('Área somente leitura');
    if (p.area === 'coil') return c.writeCoil(p.index, Boolean(coerce(value, 'bool')));
    if (p.bit != null) {
      const cur = (await c.readHoldingRegisters(p.index, 1)).data[0];
      const on = coerce(value, 'bool');
      const next = on ? cur | (1 << p.bit) : cur & ~(1 << p.bit);
      return c.writeRegister(p.index, next & 0xffff);
    }
    const regs = encode(coerce(value, tag.type), tag.type, this.cfg.wordSwap);
    if (regs.length === 1) return c.writeRegister(p.index, regs[0]);
    return c.writeRegisters(p.index, regs);
  }
}

module.exports = ModbusDriver;
module.exports.parseAddress = parseAddress;
module.exports.decode = decode;
module.exports.encode = encode;
