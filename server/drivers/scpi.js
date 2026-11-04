'use strict';
const net = require('net');
const { coerce } = require('../util');

// Driver SCPI por TCP (socket) — multímetros e instrumentos de bancada (Rigol DM858/DM858E, Keysight, Siglent...).
//
// Endereço do tag:
//   READ?                         lê a medida atual (com a função configurada no instrumento)
//   MEAS:VOLT:DC?                 configura e mede (mais lento: o instrumento troca de função)
//   *IDN?                         texto (use tipo STRING)
//   leitura? | comando {v}        lê com a consulta e escreve com o comando ({v} = valor)
//   | *RST                        só escrita (BOOL: o comando é enviado quando o valor é ligado)
//   FUNC? | CONF:{1=VOLT:DC;2=VOLT:AC;3=CURR:DC}
//                                 tabela de valores: o PLC escreve 1, 2, 3... e o comando recebe o texto;
//                                 na leitura o texto devolvido vira o número.
const OVERLOAD = 9.9e37; // valor que os multímetros devolvem em sobrecarga (OL)

function parseAddress(raw) {
  const s = String(raw || '').trim();
  const i = s.indexOf('|');
  const read = (i >= 0 ? s.slice(0, i) : s).trim();
  const write = i >= 0 ? s.slice(i + 1).trim() : (s.endsWith('?') ? '' : s);
  const m = write.match(/\{([^{}]*=[^{}]*)\}/);
  const map = m
    ? m[1].split(';').map((p) => p.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [Number(k), v.join('=').trim()])
    : null;
  return { read: read.endsWith('?') ? read : '', write, map };
}

class ScpiDriver {
  constructor(cfg) {
    this.cfg = cfg;
    this.sock = null;
    this.buf = '';
    this.waiter = null;
    this.idn = '';
    this.memory = new Map(); // último valor escrito em tags só de escrita
  }

  connect() {
    const cfg = this.cfg;
    if (!cfg.host) return Promise.reject(new Error('Informe o IP do instrumento'));
    const timeout = Number(cfg.timeout) || 3000;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: cfg.host, port: Number(cfg.port) || 5555 });
      const fail = (e) => { sock.destroy(); reject(new Error(`Falha ao conectar: ${e.message || e}`)); };
      const timer = setTimeout(() => fail(new Error('tempo esgotado')), timeout);
      sock.once('error', fail);
      sock.once('connect', async () => {
        clearTimeout(timer);
        sock.removeListener('error', fail);
        sock.setNoDelay(true);
        sock.on('data', (d) => this.onData(d));
        sock.on('error', () => this.drop('Erro de rede'));
        sock.on('close', () => this.drop('Conexão fechada pelo instrumento'));
        this.sock = sock;
        this.buf = '';
        try {
          this.idn = (await this.query('*IDN?')).trim();
          resolve();
        } catch (e) {
          this.disconnect();
          reject(new Error(`Instrumento não respondeu ao *IDN? (${e.message})`));
        }
      });
    });
  }

  drop(reason) {
    this.sock = null;
    if (this.waiter) { this.waiter.reject(new Error(reason)); this.waiter = null; }
  }

  async disconnect() {
    const s = this.sock;
    this.drop('Desconectado');
    if (s) s.destroy();
  }

  onData(d) {
    this.buf += d.toString('latin1');
    const i = this.buf.indexOf('\n');
    if (i < 0 || !this.waiter) return;
    const line = this.buf.slice(0, i).replace(/\r$/, '');
    this.buf = this.buf.slice(i + 1);
    const w = this.waiter;
    this.waiter = null;
    w.resolve(line);
  }

  send(cmd) {
    if (!this.sock) throw new Error('Conexão perdida');
    this.sock.write(cmd + '\n');
  }

  query(cmd) {
    if (!this.sock) return Promise.reject(new Error('Conexão perdida'));
    this.buf = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`Sem resposta para ${cmd}`));
      }, Number(this.cfg.timeout) || 3000);
      this.waiter = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.send(cmd);
    });
  }

  async read(tags) {
    if (!this.sock) throw new Error('Conexão perdida');
    const values = {}, errors = {};
    for (const tag of tags) {
      const a = parseAddress(tag.address);
      if (!a.read) {
        // Tag só de escrita: mostra o último valor enviado.
        values[tag.name] = this.memory.has(tag.name) ? this.memory.get(tag.name) : tag.type === 'bool' ? false : tag.type === 'string' ? '' : 0;
        continue;
      }
      try {
        const v = this.parse(await this.query(a.read), tag, a.map);
        if (v === undefined) errors[tag.name] = 'Sobrecarga (OL)';
        else values[tag.name] = v;
      } catch (e) {
        if (!this.sock) throw e;
        errors[tag.name] = e.message;
      }
    }
    return { values, errors };
  }

  parse(resp, tag, map) {
    const txt = String(resp).trim().replace(/^"(.*)"$/, '$1');
    if (map) {
      const up = txt.toUpperCase();
      const hit = map.find(([, t]) => t.toUpperCase() === up) || map.find(([, t]) => t.toUpperCase().startsWith(up) || up.startsWith(t.toUpperCase()));
      return hit ? hit[0] : 0;
    }
    if (tag.type === 'string') return txt;
    if (tag.type === 'bool') return /^(1|ON|TRUE)$/i.test(txt) || (Number.isFinite(parseFloat(txt)) && parseFloat(txt) !== 0);
    const n = parseFloat(txt);
    if (!Number.isFinite(n)) throw new Error(`Resposta não numérica: ${txt.slice(0, 40)}`);
    if (Math.abs(n) >= OVERLOAD) return undefined;
    return tag.type === 'float32' ? n : Math.round(n);
  }

  async write(tag, value) {
    const a = parseAddress(tag.address);
    if (!a.write) throw new Error('Este tag não tem comando de escrita (use "consulta? | comando {v}")');
    const v = coerce(value, tag.type);
    // BOOL sem {v}: comando de ação (ex.: *RST), enviado só quando liga.
    if (tag.type === 'bool' && !a.write.includes('{')) {
      if (v) this.send(a.write);
      this.memory.set(tag.name, v);
      return;
    }
    let cmd;
    if (a.map) {
      const hit = a.map.find(([k]) => k === Number(v));
      if (!hit && Number(v) === 0) return; // 0 = nenhum pedido
      if (!hit) throw new Error(`Valor ${v} não está na tabela do comando`);
      cmd = a.write.replace(/\{[^{}]*=[^{}]*\}/, hit[1]);
    } else {
      const txt = tag.type === 'bool' ? (v ? 'ON' : 'OFF') : String(v);
      cmd = a.write.replace(/\{v\}/g, txt);
    }
    this.send(cmd);
    this.memory.set(tag.name, v);
  }
}

module.exports = ScpiDriver;
module.exports.parseAddress = parseAddress;
