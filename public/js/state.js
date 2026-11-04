// Estado global da aplicação + comunicação com o servidor.
export const state = {
  project: null,
  models: [],
  values: {},    // tag -> { v, q, ts }
  status: {},    // conexão -> { state, error }
  alarms: { active: [], history: [] },
  dirty: false,
  wsOnline: false,
};

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export function markDirty() {
  state.dirty = true;
  emit('dirty', true);
}

export const uid = (p = 'id') => p + Math.random().toString(36).slice(2, 9);

export async function loadProject() {
  const [p, m] = await Promise.all([fetch('api/project').then((r) => r.json()), fetch('api/models').then((r) => r.json())]);
  state.project = p;
  state.models = m;
  state.dirty = false;
  emit('project');
  emit('dirty', false);
}

export async function saveProject() {
  const r = await fetch('api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.project) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Erro ao salvar');
  state.dirty = false;
  emit('dirty', false);
}

export function setProject(p) {
  state.project = p;
  emit('project');
  markDirty();
}

export const tagValue = (name) => state.values[name]?.v;
export const tagQuality = (name) => state.values[name]?.q;
export const findTag = (name) => state.project?.tags.find((t) => t.name === name);

// ---------- WebSocket ----------
let ws, seq = 0;
const pending = new Map();

export function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = location.pathname.replace(/[^/]*$/, '');
  ws = new WebSocket(`${proto}://${location.host}${base}ws`);
  ws.onopen = () => { state.wsOnline = true; emit('status', state.status); };
  ws.onclose = () => {
    state.wsOnline = false;
    emit('status', state.status);
    for (const [, p] of pending) p.reject(new Error('Sem conexão com o servidor'));
    pending.clear();
    setTimeout(connectWs, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'snapshot':
        state.values = msg.values;
        state.status = msg.status;
        state.alarms = { active: msg.active, history: msg.history };
        emit('values', msg.values);
        emit('status', state.status);
        emit('alarms', state.alarms);
        break;
      case 'values':
        Object.assign(state.values, msg.values);
        emit('values', msg.values);
        break;
      case 'status':
        state.status = msg.status;
        emit('status', state.status);
        break;
      case 'alarms':
        state.alarms = { active: msg.active, history: msg.history };
        emit('alarms', state.alarms);
        break;
      case 'writeResult': {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.ok ? p.resolve() : p.reject(new Error(msg.error)); }
        break;
      }
    }
  };
}

export function writeTag(tag, value) {
  if (!tag) return Promise.resolve();
  if (!ws || ws.readyState !== 1) {
    toast('Sem conexão com o servidor', 'err');
    return Promise.reject(new Error('offline'));
  }
  const id = ++seq;
  ws.send(JSON.stringify({ type: 'write', id, tag, value }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.delete(id)) reject(new Error('Tempo esgotado na escrita')); }, 5000);
  }).catch((e) => { toast(`Escrita em ${tag}: ${e.message}`, 'err'); throw e; });
}

export function ackAlarm(id) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ack', id }));
}

// ---------- UI helpers ----------
export function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const modal = () => document.getElementById('modal');
export function openModal(content) {
  const box = document.getElementById('modalBox');
  box.replaceChildren(content);
  modal().classList.remove('hidden');
}
export function closeModal() {
  modal().classList.add('hidden');
  document.getElementById('modalBox').replaceChildren();
}

export function confirmBox(text) {
  return new Promise((resolve) => {
    const done = (v) => { closeModal(); resolve(v); };
    openModal(h('div', {},
      h('h3', {}, 'Confirmação'),
      h('div', {}, text),
      h('div', { class: 'confirm-actions' },
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: () => done(true) }, 'Confirmar'))));
  });
}

// Teclado numérico na tela (pensado para touch).
export function keypad({ title, value, min, max, decimals }) {
  return new Promise((resolve) => {
    let txt = value == null || value === '' ? '' : String(value);
    let fresh = true;
    const disp = h('div', { class: 'disp' }, txt);
    const err = h('div', { class: 'range' }, rangeText());
    function rangeText() {
      const a = Number.isFinite(min) ? min : '-∞', b = Number.isFinite(max) ? max : '∞';
      return `Faixa: ${a} … ${b}`;
    }
    const done = (v) => { document.removeEventListener('keydown', onKey); closeModal(); resolve(v); };
    const press = (k) => {
      if (k === 'C') txt = '';
      else if (k === '⌫') txt = txt.slice(0, -1);
      else if (k === '±') txt = txt.startsWith('-') ? txt.slice(1) : '-' + txt;
      else if (k === 'OK') {
        const n = Number(txt.replace(',', '.'));
        if (txt === '' || !Number.isFinite(n)) { err.textContent = 'Valor inválido'; return; }
        if ((Number.isFinite(min) && n < min) || (Number.isFinite(max) && n > max)) { err.textContent = 'Fora da faixa! ' + rangeText(); return; }
        return done(decimals != null ? Number(n.toFixed(decimals)) : n);
      } else if (k === 'ESC') return done(null);
      else {
        if (fresh) txt = '';
        if (k === '.' && txt.includes('.')) return;
        txt += k;
      }
      fresh = false;
      disp.textContent = txt;
    };
    const onKey = (e) => {
      if (/^[0-9.]$/.test(e.key)) press(e.key);
      else if (e.key === ',') press('.');
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Enter') press('OK');
      else if (e.key === 'Escape') press('ESC');
      else if (e.key === '-') press('±');
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    const keys = ['7', '8', '9', '⌫', '4', '5', '6', 'C', '1', '2', '3', '±', '0', '.', 'ESC', 'OK'];
    openModal(h('div', { class: 'keypad' },
      h('h3', {}, title || 'Digite o valor'), disp, err,
      h('div', { class: 'keys' }, keys.map((k) => h('button', {
        class: k === 'OK' ? 'ok' : k === 'ESC' ? 'cancel' : '', onclick: () => press(k),
      }, k === 'ESC' ? 'Sair' : k)))));
  });
}
