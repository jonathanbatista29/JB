'use strict';

// Driver Siemens S7 (S7-300/400/1200/1500) via protocolo S7 (ISO-on-TCP, porta 102).
// Endereços no formato nodes7, por exemplo:
//   DB1,X0.0   bit      DB1,INT2   inteiro   DB1,REAL4  real    DB1,DINT8
//   M0.0  MW10  MD20  MR30   I0.0  Q0.1  IW64  QW64
class S7Driver {
  constructor(cfg) {
    this.cfg = cfg;
    this.conn = null;
    this.items = '';
  }

  connect() {
    const NodeS7 = require('nodes7');
    const cfg = this.cfg;
    if (!cfg.host) return Promise.reject(new Error('Informe o IP do PLC'));
    return new Promise((resolve, reject) => {
      const conn = new NodeS7({ silent: true });
      const timer = setTimeout(() => reject(new Error('Tempo esgotado ao conectar')), (Number(cfg.timeout) || 3000) + 2000);
      conn.initiateConnection(
        { host: cfg.host, port: Number(cfg.port) || 102, rack: Number(cfg.rack) || 0, slot: Number(cfg.slot ?? 1), timeout: Number(cfg.timeout) || 3000 },
        (err) => {
          clearTimeout(timer);
          if (err) return reject(new Error(`Falha ao conectar: ${err.message || err}`));
          this.conn = conn;
          this.items = '';
          resolve();
        }
      );
    });
  }

  disconnect() {
    const c = this.conn;
    this.conn = null;
    if (!c) return Promise.resolve();
    return new Promise((r) => {
      try { c.dropConnection(() => r()); } catch { r(); }
      setTimeout(r, 1000);
    });
  }

  read(tags) {
    if (!this.conn) return Promise.reject(new Error('Conexão perdida'));
    const addrs = [...new Set(tags.map((t) => String(t.address || '').trim()).filter(Boolean))];
    const key = addrs.join('|');
    if (key !== this.items) {
      this.conn.removeItems();
      if (addrs.length) this.conn.addItems(addrs);
      this.items = key;
    }
    if (!addrs.length) return Promise.resolve({ values: {}, errors: {} });

    return new Promise((resolve, reject) => {
      this.conn.readAllItems((bad, data) => {
        const values = {}, errors = {};
        let good = 0;
        for (const tag of tags) {
          const v = data ? data[String(tag.address || '').trim()] : undefined;
          if (v === undefined || (typeof v === 'string' && v.startsWith('BAD'))) errors[tag.name] = 'Leitura inválida';
          else { values[tag.name] = typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v; good++; }
        }
        if (bad && good === 0) return reject(new Error('Falha de comunicação com o PLC'));
        resolve({ values, errors });
      });
    });
  }

  write(tag, value) {
    if (!this.conn) return Promise.reject(new Error('Conexão perdida'));
    return new Promise((resolve, reject) => {
      const r = this.conn.writeItems(String(tag.address).trim(), value, (bad) => (bad ? reject(new Error('Falha na escrita')) : resolve()));
      if (r !== 0 && r !== undefined) reject(new Error('Outra escrita em andamento'));
    });
  }
}

module.exports = S7Driver;
