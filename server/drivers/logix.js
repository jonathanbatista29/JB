'use strict';
const { coerce } = require('../util');

// Driver Allen-Bradley CompactLogix / ControlLogix (EtherNet/IP, porta 44818).
// Endereço = nome do tag no Studio 5000, por exemplo:
//   Motor_Run          tag do controlador
//   Program:MainProgram.Nivel   tag de programa
//   Receita[3]         elemento de array
//   Maquina.Velocidade membro de UDT
//   Status.5           bit 5 de um DINT
class LogixDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.plc = null;
    this.tags = new Map(); // endereço -> objeto Tag da biblioteca
    this.lost = false;
  }

  async connect() {
    const { Controller } = require('st-ethernet-ip');
    const cfg = this.cfg;
    if (!cfg.host) throw new Error('Informe o IP do PLC');
    const timeout = Number(cfg.timeout) || 5000;
    const plc = new Controller(true);
    plc.timeout_sp = timeout;
    this.lost = false;
    plc.on('close', () => (this.lost = true));
    plc.on('error', () => (this.lost = true));
    let timer;
    try {
      await Promise.race([
        plc.connect(cfg.host, Number(cfg.slot) || 0, cfg.setup !== false),
        new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('Tempo esgotado ao conectar')), timeout + 2000))),
      ]);
    } catch (e) {
      try { plc.destroy(); } catch {}
      throw new Error(`Falha ao conectar: ${e.message || e}`);
    } finally {
      clearTimeout(timer);
    }
    this.plc = plc;
    this.tags.clear();
  }

  async disconnect() {
    const plc = this.plc;
    this.plc = null;
    this.tags.clear();
    if (!plc) return;
    try {
      await Promise.race([plc.disconnect(), new Promise((r) => setTimeout(r, 1000))]);
    } catch {}
    try { plc.destroy(); } catch {}
  }

  ensureOpen() {
    if (!this.plc || this.lost) throw new Error('Conexão perdida');
  }

  tagObj(address) {
    const addr = String(address || '').trim();
    let t = this.tags.get(addr);
    if (!t) {
      const m = addr.match(/^Program:([^.]+)\.(.+)$/i);
      t = m ? this.plc.newTag(m[2], m[1], false) : this.plc.newTag(addr, null, false);
      this.tags.set(addr, t);
    }
    return t;
  }

  async read(tags) {
    this.ensureOpen();
    const values = {}, errors = {};
    let good = 0;
    // Lê um tag por vez: um nome errado não derruba a leitura dos outros.
    for (const tag of tags) {
      try {
        const t = this.tagObj(tag.address);
        await this.plc.readTag(t);
        values[tag.name] = normalize(t.value);
        good++;
      } catch (e) {
        this.ensureOpen();
        errors[tag.name] = cipError(e);
        this.tags.delete(String(tag.address || '').trim());
      }
    }
    if (tags.length && !good && this.lost) throw new Error('Conexão perdida');
    return { values, errors };
  }

  async write(tag, value) {
    this.ensureOpen();
    const t = this.tagObj(tag.address);
    t.value = coerce(value, tag.type);
    try {
      await this.plc.writeTag(t);
    } catch (e) {
      throw new Error(cipError(e));
    }
  }
}

const CIP_STATUS = {
  4: 'Tag não encontrado (verifique o nome)',
  5: 'Tag não encontrado (verifique o nome)',
  8: 'Serviço não suportado pelo controlador',
  0x0f: 'Acesso negado (tag sem permissão externa?)',
  0x13: 'Dados insuficientes',
  0x1e: 'Erro em serviço embutido',
};

function cipError(e) {
  if (e instanceof Error) return e.message;
  if (e && e.generalStatusCode != null) return CIP_STATUS[e.generalStatusCode] || `Erro CIP ${e.generalStatusCode}`;
  return String(e);
}

function normalize(v) {
  if (v == null || typeof v !== 'object') return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v;
  if (typeof v === 'bigint') return Number(v);
  return JSON.stringify(v); // UDT/array inteiro: mostra como texto
}

module.exports = LogixDriver;
