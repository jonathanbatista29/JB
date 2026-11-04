'use strict';
const { EventEmitter } = require('events');

// Gateway: copia valores entre tags de conexões diferentes, por exemplo
//   multímetro (medida)      -> PLC (DB/registrador)
//   PLC (comando/função)     -> multímetro
// Cada ligação ("ponte") tem origem, destino, ganho/offset e modo:
//   change: copia sempre que a origem muda (e reenvia quando o destino reconecta)
//   pulse : só quando a origem liga (0 -> 1); opcionalmente desliga a origem depois
// A origem também pode ser o status de uma conexão: "@status:<id>" (1 = online, 0 = offline).
class Gateway extends EventEmitter {
  constructor(tm) {
    super();
    this.tm = tm;
    this.bridges = [];
    this.st = new Map(); // id -> { last, prevSrc, sent, ts, error, busy, pending }
  }

  configure(project) {
    this.project = project;
    this.bridges = (project.gateway || []).filter((b) => b && b.id);
    const ids = new Set(this.bridges.map((b) => b.id));
    for (const k of [...this.st.keys()]) if (!ids.has(k)) this.st.delete(k);
    for (const b of this.bridges) if (!this.st.has(b.id)) this.st.set(b.id, {});
    // Valores que já existem são enviados assim que os destinos estiverem online.
    setTimeout(() => this.resendAll(), 500);
    this.publish();
  }

  srcValue(b) {
    const m = String(b.source || '').match(/^@status:(.+)$/);
    if (m) return { v: this.tm.status[m[1]]?.state === 'online' ? 1 : 0, q: 'good' };
    return this.tm.values[b.source];
  }

  onValues(changed) {
    for (const b of this.bridges) if (b.enabled !== false && changed[b.source]) this.handle(b, changed[b.source]);
  }

  onStatus(status) {
    for (const b of this.bridges) {
      if (b.enabled === false) continue;
      const m = String(b.source || '').match(/^@status:(.+)$/);
      if (m) this.handle(b, this.srcValue(b));
    }
    // Destino voltou a ficar online: reenvia o último valor (modo "change").
    for (const b of this.bridges) {
      const tag = this.project.tags.find((t) => t.name === b.target);
      const s = this.st.get(b.id);
      if (!tag || !s || b.mode === 'pulse') continue;
      const online = status[tag.connection]?.state === 'online';
      if (online && !s.targetOnline) { s.sent = undefined; const v = this.srcValue(b); if (v) this.handle(b, v); }
      s.targetOnline = online;
    }
  }

  resendAll() {
    for (const b of this.bridges) {
      if (b.enabled === false || b.mode === 'pulse') continue;
      const v = this.srcValue(b);
      if (v) this.handle(b, v);
    }
  }

  handle(b, val) {
    const s = this.st.get(b.id);
    if (!s || !val || val.q !== 'good' || val.v == null) return;
    const raw = val.v;
    if (b.mode === 'pulse') {
      const on = raw === true || (typeof raw === 'number' && raw !== 0);
      const was = s.prevSrc;
      s.prevSrc = on;
      if (!on || was === true) return;
      this.send(b, s, b.value === '' || b.value == null ? true : Number(b.value));
      if (b.resetSource && !String(b.source).startsWith('@')) {
        this.tm.write(b.source, false).catch((e) => this.fail(b, s, `Não foi possível desligar ${b.source}: ${e.message}`));
      }
      return;
    }
    let v = raw;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v === 'number') v = v * (Number(b.gain) || (b.gain === 0 ? 0 : 1)) + (Number(b.offset) || 0);
    if (s.sent !== undefined && s.sent === v) return;
    this.send(b, s, v);
  }

  // Uma escrita por vez em cada ponte; se chegar valor novo durante a escrita, envia o mais recente depois.
  send(b, s, v) {
    if (s.busy) { s.pending = { v }; return; }
    s.busy = true;
    this.tm.write(b.target, v)
      .then(() => { s.sent = v; s.ts = Date.now(); s.error = null; s.count = (s.count || 0) + 1; })
      .catch((e) => { s.sent = undefined; this.fail(b, s, e.message); })
      .finally(() => {
        s.busy = false;
        const p = s.pending;
        s.pending = null;
        if (p && p.v !== s.sent) this.send(b, s, p.v);
        this.publish();
      });
  }

  fail(b, s, msg) {
    s.error = msg;
    s.errorTs = Date.now();
    this.publish();
  }

  state() {
    return this.bridges.map((b) => {
      const s = this.st.get(b.id) || {};
      return { id: b.id, sent: s.sent, ts: s.ts, error: s.error || null, count: s.count || 0 };
    });
  }

  publish() {
    clearTimeout(this.pubTimer);
    this.pubTimer = setTimeout(() => this.emit('state', this.state()), 200);
  }
}

module.exports = { Gateway };
