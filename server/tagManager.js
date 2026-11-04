'use strict';
const { EventEmitter } = require('events');
const { createDriver } = require('./drivers');
const { coerce, createQueue, sleep } = require('./util');

const RECONNECT_MS = 3000;
const HISTORY_MAX = 500;

// Gerencia as conexões com os PLCs: leitura cíclica, escrita e alarmes.
class TagManager extends EventEmitter {
  constructor() {
    super();
    this.project = { connections: [], tags: [], alarms: [] };
    this.values = {};   // nome do tag -> { v, q, ts }
    this.status = {};   // id da conexão -> { state, error, ts }
    this.conns = new Map();
    this.active = {};   // id do alarme -> alarme ativo
    this.history = [];
  }

  async load(project) {
    await this.stopAll();
    this.project = project;
    this.status = {};
    const names = new Set(project.tags.map((t) => t.name));
    for (const k of Object.keys(this.values)) if (!names.has(k)) delete this.values[k];
    for (const id of Object.keys(this.active)) if (!project.alarms.some((a) => a.id === id)) delete this.active[id];

    for (const cfg of project.connections) {
      if (cfg.enabled === false) {
        this.setStatus(cfg.id, 'disabled');
        continue;
      }
      let driver;
      try {
        driver = createDriver(cfg);
      } catch (e) {
        this.setStatus(cfg.id, 'error', e.message);
        continue;
      }
      const st = { cfg, driver, connected: false, stopped: false, timer: null, queue: createQueue() };
      this.conns.set(cfg.id, st);
      this.poll(st);
    }
    // Tags sem conexão ativa (desativada, com erro ou inexistente) não podem ficar com o
    // último valor como "bom": a tela e o histórico gravariam um valor congelado.
    const changed = {};
    for (const tag of project.tags) {
      const prev = this.values[tag.name];
      if (!this.conns.has(tag.connection) && (!prev || prev.q !== 'bad')) {
        changed[tag.name] = this.values[tag.name] = { v: prev ? prev.v : null, q: 'bad', ts: Date.now() };
      }
    }
    this.publish(changed);
    this.emit('alarms');
  }

  async stopAll() {
    const list = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(list.map(async (st) => {
      st.stopped = true;
      clearTimeout(st.timer);
      try { await st.queue(() => st.driver.disconnect()); } catch {}
    }));
  }

  setStatus(id, state, error = null) {
    const prev = this.status[id];
    if (prev && prev.state === state && prev.error === error) return;
    this.status[id] = { state, error, ts: Date.now() };
    this.emit('status', this.status);
  }

  tagsOf(connId) {
    return this.project.tags.filter((t) => t.connection === connId);
  }

  async poll(st) {
    if (st.stopped) return;
    const id = st.cfg.id;
    let delay = Math.max(50, Number(st.cfg.pollMs) || 500);
    try {
      await st.queue(async () => {
        if (st.stopped) return;
        if (!st.connected) {
          this.setStatus(id, 'connecting');
          await st.driver.connect();
          st.connected = true;
        }
        const tags = this.tagsOf(id);
        const { values, errors } = await st.driver.read(tags);
        if (st.stopped) return;
        const now = Date.now();
        const changed = {};
        for (const tag of tags) {
          const prev = this.values[tag.name];
          if (tag.name in values) {
            const v = values[tag.name];
            if (!prev || prev.v !== v || prev.q !== 'good') changed[tag.name] = this.values[tag.name] = { v, q: 'good', ts: now };
          } else if (!prev || prev.q !== 'bad') {
            changed[tag.name] = this.values[tag.name] = { v: prev ? prev.v : null, q: 'bad', ts: now, err: errors[tag.name] };
          }
        }
        const errCount = Object.keys(errors).length;
        this.setStatus(id, 'online', errCount ? `${errCount} tag(s) com erro: ${Object.values(errors)[0]}` : null);
        this.publish(changed);
      });
    } catch (e) {
      if (st.stopped) return;
      st.connected = false;
      this.setStatus(id, 'error', e.message || String(e));
      try { await st.driver.disconnect(); } catch {}
      this.markBad(id);
      delay = RECONNECT_MS;
    }
    if (!st.stopped) st.timer = setTimeout(() => this.poll(st), delay);
  }

  markBad(connId) {
    const changed = {};
    for (const tag of this.tagsOf(connId)) {
      const prev = this.values[tag.name];
      if (!prev || prev.q !== 'bad') changed[tag.name] = this.values[tag.name] = { v: prev ? prev.v : null, q: 'bad', ts: Date.now() };
    }
    this.publish(changed);
  }

  publish(changed) {
    if (!Object.keys(changed).length) return;
    this.emit('values', changed);
    this.checkAlarms(Object.keys(changed));
  }

  async write(tagName, value) {
    const tag = this.project.tags.find((t) => t.name === tagName);
    if (!tag) throw new Error(`Tag não encontrado: ${tagName}`);
    if (tag.access === 'R') throw new Error(`Tag ${tagName} é somente leitura`);
    const st = this.conns.get(tag.connection);
    if (!st) throw new Error('Conexão do tag está desativada ou não existe');
    const v = coerce(value, tag.type);
    await st.queue(async () => {
      if (!st.connected) throw new Error('PLC desconectado');
      await st.driver.write(tag, v);
    });
    // Atualiza na hora para a tela responder rápido; a próxima leitura confirma.
    this.publish({ [tagName]: (this.values[tagName] = { v, q: 'good', ts: Date.now() }) });
  }

  // ---------- Alarmes ----------
  checkAlarms(tagNames) {
    const set = new Set(tagNames);
    let dirty = false;
    for (const al of this.project.alarms || []) {
      if (!set.has(al.tag)) continue;
      const cur = this.values[al.tag];
      if (!cur || cur.q !== 'good') continue;
      const on = evalCondition(cur.v, al.condition, al.limit);
      const act = this.active[al.id];
      if (on && !act) {
        this.active[al.id] = { id: al.id, message: al.message, priority: al.priority || 'media', tag: al.tag, value: cur.v, since: Date.now(), acked: false };
        this.log(al, 'ATIVO', cur.v);
        dirty = true;
      } else if (!on && act) {
        this.log(al, 'NORMAL', cur.v);
        if (act.acked) delete this.active[al.id];
        else act.cleared = true;
        dirty = true;
      }
    }
    if (dirty) this.emit('alarms');
  }

  ack(id, user) {
    const ids = id === '*' ? Object.keys(this.active) : [id];
    for (const i of ids) {
      const act = this.active[i];
      if (!act || act.acked) continue;
      act.acked = true;
      const al = (this.project.alarms || []).find((a) => a.id === i);
      if (al) this.log(al, 'RECONHECIDO', act.value, user);
      if (act.cleared) delete this.active[i];
    }
    this.emit('alarms');
  }

  log(al, event, value, user) {
    const e = { ts: Date.now(), event, message: al.message, tag: al.tag, value, priority: al.priority || 'media', user: user || '' };
    this.history.unshift(e);
    this.emit('alarmEvent', e);
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
  }

  alarmState() {
    return { active: Object.values(this.active).sort((a, b) => b.since - a.since), history: this.history.slice(0, 200) };
  }
}

function evalCondition(v, cond, limit) {
  const n = Number(v), l = Number(limit);
  switch (cond) {
    case 'true': return Boolean(v);
    case 'false': return !v;
    case '>': return n > l;
    case '>=': return n >= l;
    case '<': return n < l;
    case '<=': return n <= l;
    case '==': return n === l;
    case '!=': return n !== l;
    default: return false;
  }
}

module.exports = { TagManager, sleep };
