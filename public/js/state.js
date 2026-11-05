// Estado global da aplicação + comunicação com o servidor.
export const state = {
  project: null,
  models: [],
  values: {},    // tag -> { v, q, ts }
  status: {},    // conexão -> { state, error }
  alarms: { active: [], history: [] },
  dirty: false,
  wsOnline: false,
  gateway: [],  // situação de cada ligação do gateway
  mode: { mode: 'edit' }, // modo do projeto: 'edit' (edição) ou 'production' (produção)
  me: { user: null, level: -1, guestLevel: 0, idleMinutes: 10, levels: [] },
};

// Níveis de acesso
export const LV = { NONE: -1, VIEW: 0, OPERATOR: 1, MAINT: 2, ENG: 3, ADMIN: 4 };
export const LEVEL_NAMES = { '-1': 'Sem acesso', 0: 'Visualizador', 1: 'Operador', 2: 'Manutenção', 3: 'Engenharia', 4: 'Administrador' };
export const can = (min) => state.me.level >= min;
export const isProduction = () => state.mode.mode === 'production';
// Pode alterar a configuração: Engenharia e projeto em modo edição.
export const canEdit = () => can(LV.ENG) && !isProduction();

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
// Assina um evento. Devolve uma função que cancela a assinatura.
export const on = (name, fn) => {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
};

export function markDirty() {
  state.dirty = true;
  emit('dirty', true);
}

export const uid = (p = 'id') => p + Math.random().toString(36).slice(2, 9);

// Chamada à API que devolve JSON e transforma erro em exceção.
export async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const e = new Error(j.error || `Erro ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

export async function loadMe() {
  state.me = await api('api/me');
  if (state.me.user?.mustChange) state.me.level = LV.NONE;
  emit('me', state.me);
  return state.me;
}

export async function loadProject() {
  const [p, m] = await Promise.all([api('api/project'), api('api/models')]);
  state.project = p;
  state.models = m;
  state.dirty = false;
  emit('project');
  emit('dirty', false);
}

export async function saveProject() {
  state.savingUntil = Date.now() + 5000; // o aviso "projectSaved" deste salvamento é ignorado aqui
  await api('api/project', { method: 'PUT', body: state.project });
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

export function reconnectWs() {
  const old = ws;
  ws = null;
  if (old) { old.onclose = null; old.close(); }
  connectWs();
}

export function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = location.pathname.replace(/[^/]*$/, '');
  ws = new WebSocket(`${proto}://${location.host}${base}ws`);
  ws.onopen = () => { state.wsOnline = true; emit('status', state.status); };
  const me = ws;
  ws.onclose = (ev) => {
    if (ws !== me) return; // conexão antiga substituída após login/logout
    state.wsOnline = false;
    emit('status', state.status);
    for (const [, p] of pending) p.reject(new Error('Sem conexão com o servidor'));
    pending.clear();
    // 4001 = acesso mudou (logout, sessão expirada, permissão alterada): recarrega o usuário.
    if (ev.code === 4001) emit('sessionChanged');
    else setTimeout(connectWs, 2000);
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
      case 'gateway':
        state.gateway = msg.bridges;
        emit('gateway', msg.bridges);
        break;
      case 'mode':
        state.mode = { mode: msg.mode, since: msg.since, by: msg.by, startScreen: msg.startScreen };
        emit('mode', state.mode);
        break;
      case 'projectSaved':
        if (!(state.savingUntil > Date.now())) emit('projectSaved');
        break;
      case 'navigate':
        emit('plcNavigate', msg);
        break;
      case 'writeResult': {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.ok ? p.resolve() : p.reject(new Error(msg.error)); }
        break;
      }
    }
  };
}

// Nível mínimo para escrever num tag (padrão: operador).
export const tagWriteLevel = (name) => Math.max(LV.OPERATOR, Number(findTag(name)?.writeLevel) || LV.OPERATOR);

export function writeTag(tag, value) {
  if (!tag) return Promise.resolve();
  const min = tagWriteLevel(tag);
  if (!can(min)) {
    emit('needLogin', { min, reason: `Escrever em ${tag} exige nível ${LEVEL_NAMES[min]}` });
    return Promise.reject(new Error('sem permissão'));
  }
  if (!ws || ws.readyState !== 1) {
    toast('Sem conexão com o servidor', 'err');
    return Promise.reject(new Error('offline'));
  }
  const id = ++seq;
  ws.send(JSON.stringify({ type: 'write', id, tag, value }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.delete(id)) reject(new Error('Tempo esgotado na escrita')); }, 5000);
  }).catch((e) => { if (e.message !== 'sem permissão') toast(`Escrita em ${tag}: ${e.message}`, 'err'); throw e; });
}

// Informa ao servidor a tela que está sendo mostrada (para o tag de "tela atual" do PLC).
export function reportScreen(screen) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'screen', screen }));
}

export function ackAlarm(id) {
  if (!can(LV.OPERATOR)) return emit('needLogin', { min: LV.OPERATOR, reason: 'Reconhecer alarmes exige login de operador' });
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
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const modal = () => document.getElementById('modal');
// `locked`: não fecha ao clicar fora (login obrigatório, troca de senha forçada).
export function openModal(content, { locked = false } = {}) {
  const box = document.getElementById('modalBox');
  box.replaceChildren(content);
  modal().classList.remove('hidden');
  modal().dataset.locked = locked ? '1' : '';
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

// ---------- Tabelas com colunas redimensionáveis (como no Excel) ----------
// Arraste a divisória do cabeçalho para mudar a largura; duplo clique volta ao automático.
// A largura escolhida fica guardada neste navegador.
const loadJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export function resizableTable(table, key) {
  const ths = [...table.querySelectorAll(':scope > thead > tr > th')];
  if (!ths.length || table.dataset.resizable) return;
  table.dataset.resizable = '1';
  const store = 'jbihm.colw.' + key;
  let widths = loadJSON(store);
  const total = () => ths.reduce((s, th, i) => s + (widths[i] || th.offsetWidth), 0);
  const apply = () => {
    if (!Object.keys(widths).length) return;
    // Congela as outras colunas na largura atual e aplica as escolhidas.
    ths.forEach((th, i) => { th.style.width = (widths[i] || th.offsetWidth) + 'px'; });
    table.classList.add('cols-fixed');
    table.style.width = total() + 'px';
  };
  const reset = () => {
    widths = {};
    saveJSON(store, widths);
    table.classList.remove('cols-fixed');
    table.style.width = '';
    ths.forEach((th) => { th.style.width = ''; });
  };
  ths.forEach((th, i) => {
    const grip = h('span', { class: 'col-grip', title: 'Arraste para mudar a largura · duplo clique volta ao automático' });
    grip.addEventListener('dblclick', (e) => { e.stopPropagation(); reset(); });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ths.forEach((t, j) => { if (!widths[j]) widths[j] = t.offsetWidth; });
      apply();
      const x0 = e.clientX, w0 = widths[i];
      grip.setPointerCapture?.(e.pointerId);
      document.body.classList.add('col-resizing');
      const move = (ev) => {
        widths[i] = Math.max(36, Math.round(w0 + ev.clientX - x0));
        th.style.width = widths[i] + 'px';
        table.style.width = total() + 'px';
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        document.body.classList.remove('col-resizing');
        saveJSON(store, widths);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    th.append(grip);
  });
  // Aplica as larguras guardadas depois que a tabela aparecer na tela.
  if (Object.keys(widths).length) requestAnimationFrame(apply);
}

// Liga o redimensionamento em todas as tabelas (.grid) de uma página.
export function resizableTables(root, prefix) {
  root.querySelectorAll('table.grid').forEach((t, i) => resizableTable(t, `${prefix}-${t.dataset.key || i}`));
}

// ---------- Seções que minimizam (▾ / ▸) ----------
// A escolha (aberta ou minimizada) fica guardada neste navegador.
export function collapsible(key, title, actions, body) {
  const store = 'jbihm.sec';
  const open = loadJSON(store)[key] !== false;
  const arrow = h('span', { class: 'sec-arrow' }, open ? '▾' : '▸');
  const box = h('div', { class: 'sec-body' + (open ? '' : ' hidden') }, body);
  const toggle = () => {
    const all = loadJSON(store);
    const now = box.classList.toggle('hidden');
    all[key] = !now;
    saveJSON(store, all);
    arrow.textContent = now ? '▸' : '▾';
  };
  return h('div', { class: 'section' },
    h('div', { class: 'head' },
      h('h2', { class: 'section-title sec-toggle', title: 'Clique para minimizar ou expandir', onclick: toggle }, arrow, ' ', title),
      actions || ''),
    box);
}
