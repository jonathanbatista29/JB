// Editor de telas: arrastar objetos, redimensionar, editar propriedades.
import { state, on, h, markDirty, uid, confirmBox, toast } from './state.js';
import { WIDGETS, renderWidget, newWidget } from './widgets.js';

const GRID = 10;
let root, stage, props, screenSel, zoomSel, screenEl;
let screenId = null, selId = null, zoom = 1, zoomMode = 'fit', grid = true, clipboard = null;
let boxes = new Map();
const undo = [];

const scr = () => state.project.screens.find((s) => s.id === screenId) || state.project.screens[0];
const selW = () => scr()?.widgets.find((w) => w.id === selId);
const snap = (v) => (grid ? Math.round(v / GRID) * GRID : Math.round(v));

export function initEditor(el, { onTest }) {
  root = el;
  // Paleta
  const palette = h('div', { class: 'ed-palette' });
  const groups = {};
  for (const [type, def] of Object.entries(WIDGETS)) (groups[def.group] ||= []).push([type, def]);
  for (const [g, list] of Object.entries(groups)) {
    palette.append(h('h4', {}, g));
    for (const [type, def] of list) {
      palette.append(h('div', {
        class: 'pal-item', draggable: 'true', title: 'Arraste para a tela ou clique para adicionar',
        ondragstart: (e) => e.dataTransfer.setData('text/x-widget', type),
        onclick: () => addWidget(type),
      }, h('span', { class: 'ic' }, def.icon), def.name));
    }
  }
  palette.append(h('p', { class: 'hint', style: { marginTop: '14px' } },
    'Atalhos: Del apaga, Ctrl+D duplica, Ctrl+C/V copia/cola, Ctrl+Z desfaz, setas movem (Shift = 10px).'));

  // Barra de ferramentas
  screenSel = h('select', { onchange: () => { screenId = screenSel.value; selId = null; renderAll(); } });
  zoomSel = h('select', { onchange: () => { zoomMode = zoomSel.value; applyZoom(); } },
    h('option', { value: 'fit', selected: true }, 'Ajustar'),
    [0.5, 0.75, 1, 1.25, 1.5].map((z) => h('option', { value: z }, Math.round(z * 100) + '%')));
  const gridChk = h('input', { type: 'checkbox', checked: true, onchange: () => { grid = gridChk.checked; screenEl?.classList.toggle('grid', grid); } });
  const toolbar = h('div', { class: 'ed-toolbar' },
    h('span', { class: 'hint' }, 'Tela:'), screenSel,
    h('button', { class: 'btn small', onclick: addScreen }, '+ Nova tela'),
    h('button', { class: 'btn small', onclick: dupScreen }, 'Duplicar'),
    h('button', { class: 'btn small danger', onclick: delScreen }, 'Excluir'),
    h('span', { class: 'sep' }),
    h('span', { class: 'hint' }, 'Zoom'), zoomSel,
    h('label', { class: 'check' }, gridChk, 'Grade'),
    h('button', { class: 'btn small', onclick: doUndo, title: 'Ctrl+Z' }, '↶ Desfazer'),
    h('span', { class: 'sep' }),
    h('button', { class: 'btn small primary', onclick: () => onTest(screenId) }, '▶ Testar tela'));

  stage = h('div', { class: 'ed-stage' });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', onDrop);
  stage.addEventListener('pointerdown', (e) => { if (e.target === stage) select(null); });

  props = h('div', { class: 'ed-props' });
  new ResizeObserver(() => zoomMode === 'fit' && applyZoom()).observe(stage);
  root.append(palette, h('div', { class: 'ed-center' }, toolbar, stage), props);

  on('project', () => { if (!state.project.screens.some((s) => s.id === screenId)) screenId = null; selId = null; renderAll(); });
  on('values', () => { if (root.classList.contains('active')) for (const b of boxes.values()) b._update(); });
  document.addEventListener('keydown', onKey);
}

export function refreshEditor() {
  renderAll();
}

function renderAll() {
  if (!state.project) return;
  const s = scr();
  screenId = s.id;
  screenSel.replaceChildren(...state.project.screens.map((x) => h('option', { value: x.id, selected: x.id === s.id }, x.name)));
  renderCanvas();
  renderProps();
}

function renderCanvas() {
  const s = scr();
  for (const b of boxes.values()) b._destroy();
  boxes = new Map();
  screenEl = h('div', { class: 'screen' + (grid ? ' grid' : ''), style: { width: s.width + 'px', height: s.height + 'px', background: s.bg } });
  for (const w of s.widgets) screenEl.append(makeBox(w));
  screenEl.addEventListener('pointerdown', onPointerDown);
  const holder = h('div', { style: { position: 'relative' } }, screenEl);
  stage.replaceChildren(holder);
  applyZoom();
}

function makeBox(w) {
  const b = renderWidget(w, { runtime: false, navigate: () => {} });
  boxes.set(w.id, b);
  if (w.id === selId) markSel(b);
  return b;
}

function markSel(b) {
  b.classList.add('sel');
  b.append(h('div', { class: 'rh' }));
}

function refreshBox(w) {
  const old = boxes.get(w.id);
  const b = makeBox(w);
  if (old) { old._destroy(); old.replaceWith(b); } else screenEl.append(b);
}

function applyZoom() {
  if (!screenEl || !state.project) return;
  const s = scr();
  if (zoomMode === 'fit') {
    const aw = stage.clientWidth - 60, ah = stage.clientHeight - 60;
    zoom = aw > 0 && ah > 0 ? Math.max(0.2, Math.min(1.5, aw / s.width, ah / s.height)) : 1;
  } else zoom = Number(zoomMode);
  screenEl.style.transform = `scale(${zoom})`;
  screenEl.style.transformOrigin = '0 0';
  screenEl.parentElement.style.width = s.width * zoom + 'px';
  screenEl.parentElement.style.height = s.height * zoom + 'px';
}

function select(id) {
  if (selId === id) return;
  const prev = boxes.get(selId);
  if (prev) { prev.classList.remove('sel'); prev.querySelector('.rh')?.remove(); }
  selId = id;
  const b = boxes.get(id);
  if (b) markSel(b);
  renderProps();
}

function pushUndo() {
  undo.push({ screenId, widgets: JSON.stringify(scr().widgets) });
  if (undo.length > 60) undo.shift();
}

function doUndo() {
  const u = undo.pop();
  if (!u) return toast('Nada para desfazer');
  const s = state.project.screens.find((x) => x.id === u.screenId);
  if (!s) return;
  s.widgets = JSON.parse(u.widgets);
  screenId = s.id;
  if (!s.widgets.some((w) => w.id === selId)) selId = null;
  markDirty();
  renderAll();
}

// ---------- Mover / redimensionar ----------
function onPointerDown(e) {
  const box = e.target.closest('.wgt');
  if (!box) { select(null); return; }
  e.preventDefault();
  const w = scr().widgets.find((x) => x.id === box.dataset.id);
  select(w.id);
  const resize = e.target.classList.contains('rh');
  const start = { x: e.clientX, y: e.clientY, wx: w.x, wy: w.y, ww: w.w, wh: w.h };
  let moved = false;
  const move = (ev) => {
    const dx = (ev.clientX - start.x) / zoom, dy = (ev.clientY - start.y) / zoom;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!moved) { pushUndo(); moved = true; }
    const s = scr();
    if (resize) {
      w.w = Math.max(10, snap(start.ww + dx));
      w.h = Math.max(10, snap(start.wh + dy));
    } else {
      w.x = Math.max(0, Math.min(s.width - 10, snap(start.wx + dx)));
      w.y = Math.max(0, Math.min(s.height - 10, snap(start.wy + dy)));
    }
    Object.assign(box.style, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) {
      markDirty();
      if (resize) refreshBox(w);
      renderProps();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onDrop(e) {
  const type = e.dataTransfer.getData('text/x-widget');
  if (!type || !screenEl) return;
  e.preventDefault();
  const r = screenEl.getBoundingClientRect();
  addWidget(type, snap((e.clientX - r.left) / zoom), snap((e.clientY - r.top) / zoom));
}

let addOffset = 0;
function addWidget(type, x, y) {
  const s = scr();
  if (x == null) { addOffset = (addOffset + 20) % 200; x = 20 + addOffset; y = 80 + addOffset; }
  const w = newWidget(type, x, y);
  w.x = Math.min(w.x, Math.max(0, s.width - w.w));
  w.y = Math.min(w.y, Math.max(0, s.height - w.h));
  pushUndo();
  s.widgets.push(w);
  markDirty();
  refreshBox(w);
  select(w.id);
}

function deleteSel() {
  const s = scr();
  const i = s.widgets.findIndex((w) => w.id === selId);
  if (i < 0) return;
  pushUndo();
  s.widgets.splice(i, 1);
  boxes.get(selId)?._destroy();
  boxes.get(selId)?.remove();
  boxes.delete(selId);
  selId = null;
  markDirty();
  renderProps();
}

function duplicate(src = selW(), dx = 20) {
  if (!src) return;
  const s = scr();
  const w = { ...structuredClone(src), id: uid('w'), x: Math.min(src.x + dx, s.width - 10), y: Math.min(src.y + dx, s.height - 10) };
  pushUndo();
  s.widgets.push(w);
  markDirty();
  refreshBox(w);
  select(w.id);
}

function reorder(front) {
  const s = scr(), w = selW();
  if (!w) return;
  pushUndo();
  s.widgets = s.widgets.filter((x) => x !== w);
  front ? s.widgets.push(w) : s.widgets.unshift(w);
  markDirty();
  renderCanvas();
}

function onKey(e) {
  if (!root.classList.contains('active')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (!document.getElementById('modal').classList.contains('hidden')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const w = selW();
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
  if (ctrl && e.key.toLowerCase() === 'v' && clipboard) { e.preventDefault(); duplicate(clipboard, 20); clipboard = structuredClone(selW()); return; }
  if (!w) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
  else if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); }
  else if (ctrl && e.key.toLowerCase() === 'c') { clipboard = structuredClone(w); toast('Copiado'); }
  else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1;
    pushUndo();
    if (e.key === 'ArrowLeft') w.x = Math.max(0, w.x - st);
    if (e.key === 'ArrowRight') w.x += st;
    if (e.key === 'ArrowUp') w.y = Math.max(0, w.y - st);
    if (e.key === 'ArrowDown') w.y += st;
    const b = boxes.get(w.id);
    Object.assign(b.style, { left: w.x + 'px', top: w.y + 'px' });
    markDirty();
    renderProps();
  }
}

// ---------- Telas ----------
function addScreen() {
  const s = { id: uid('tela'), name: `Tela ${state.project.screens.length + 1}`, width: scr()?.width || 1024, height: scr()?.height || 600, bg: '#1e2530', widgets: [] };
  state.project.screens.push(s);
  screenId = s.id;
  selId = null;
  markDirty();
  renderAll();
}

function dupScreen() {
  const s = structuredClone(scr());
  s.id = uid('tela');
  s.name += ' (cópia)';
  for (const w of s.widgets) w.id = uid('w');
  state.project.screens.push(s);
  screenId = s.id;
  markDirty();
  renderAll();
}

async function delScreen() {
  if (state.project.screens.length <= 1) return toast('O projeto precisa de pelo menos uma tela', 'err');
  if (!(await confirmBox(`Excluir a tela "${scr().name}"?`))) return;
  state.project.screens = state.project.screens.filter((s) => s.id !== screenId);
  screenId = null;
  selId = null;
  markDirty();
  renderAll();
}

// ---------- Painel de propriedades ----------
function field(label, input, full) {
  return h('label', { class: 'field' + (full ? ' full' : '') }, label, input);
}

function inputFor(def, obj, onChange, before = () => {}) {
  const v = obj[def.key];
  const set = (val) => { before(); obj[def.key] = val; onChange(def); };
  switch (def.kind) {
    case 'number': return h('input', { type: 'number', value: v ?? '', onchange: (e) => set(e.target.value === '' ? '' : Number(e.target.value)) });
    case 'color': {
      const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
      return h('div', { style: { display: 'flex', gap: '4px' } },
        h('input', { type: 'color', value: hex, style: { width: '40px', flexShrink: 0 }, oninput: (e) => { e.target.nextSibling.value = e.target.value; set(e.target.value); } }),
        h('input', { type: 'text', value: v ?? '', onchange: (e) => set(e.target.value) }));
    }
    case 'bool': return h('input', { type: 'checkbox', checked: Boolean(v), onchange: (e) => set(e.target.checked) });
    case 'textarea': return h('textarea', { rows: 3, onchange: (e) => set(e.target.value) }, v ?? '');
    case 'select': return h('select', { onchange: (e) => set(e.target.value) }, def.options.map(([val, txt]) => h('option', { value: val, selected: val === v }, txt)));
    case 'tag': {
      const tags = state.project.tags;
      const sel = h('select', { onchange: (e) => set(e.target.value) },
        h('option', { value: '' }, '— nenhum —'),
        tags.map((t) => h('option', { value: t.name, selected: t.name === v }, `${t.name}${t.description ? ' — ' + t.description : ''}`)));
      if (v && !tags.some((t) => t.name === v)) sel.append(h('option', { value: v, selected: true }, `${v} (não existe!)`));
      return sel;
    }
    case 'screen': return h('select', { onchange: (e) => set(e.target.value) },
      h('option', { value: '' }, '— escolha —'),
      state.project.screens.map((s) => h('option', { value: s.id, selected: s.id === v }, s.name)));
    default: return h('input', { type: 'text', value: v ?? '', onchange: (e) => set(e.target.value) });
  }
}

function renderProps() {
  const w = selW();
  if (!w) return renderScreenProps();
  const def = WIDGETS[w.type];
  const onChange = (pd) => {
    markDirty();
    refreshBox(w);
    if (pd.kind === 'select' || pd.kind === 'bool') renderProps();
  };
  const geo = (key, label) => h('label', { class: 'field' }, label, h('input', {
    type: 'number', value: w[key], onchange: (e) => {
      pushUndo(); w[key] = Math.max(key === 'w' || key === 'h' ? 10 : 0, Number(e.target.value) || 0); markDirty(); refreshBox(w);
    },
  }));
  props.replaceChildren(
    h('h4', {}, `${def?.icon || ''} ${def?.name || w.type}`),
    h('div', { class: 'prop-grid' }, geo('x', 'X'), geo('y', 'Y'), geo('w', 'Largura'), geo('h', 'Altura')),
    h('h4', {}, 'Propriedades'),
    h('div', { class: 'prop-grid' },
      (def?.props || []).filter((pd) => !pd.showIf || pd.showIf(w.props)).map((pd) =>
        pd.kind === 'bool'
          ? h('label', { class: 'check' + (pd.full ? ' full' : '') }, inputFor(pd, w.props, onChange, pushUndo), pd.label)
          : field(pd.label, inputFor(pd, w.props, onChange, pushUndo), pd.full || pd.kind === 'textarea'))),
    h('div', { class: 'prop-actions' },
      h('button', { class: 'btn small', onclick: () => duplicate() }, 'Duplicar'),
      h('button', { class: 'btn small', onclick: () => reorder(true) }, 'Trazer p/ frente'),
      h('button', { class: 'btn small', onclick: () => reorder(false) }, 'Enviar p/ trás'),
      h('button', { class: 'btn small danger', onclick: deleteSel }, 'Excluir')));
}

function renderScreenProps() {
  const s = scr();
  const change = (key, conv = (x) => x) => (e) => {
    s[key] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    markDirty();
    if (key === 'name') renderAll(); else renderCanvas();
  };
  props.replaceChildren(
    h('h4', {}, 'Propriedades da tela'),
    h('div', { class: 'prop-grid' },
      field('Nome', h('input', { type: 'text', value: s.name, onchange: change('name') }), true),
      field('Largura (px)', h('input', { type: 'number', value: s.width, onchange: change('width', (v) => Math.max(200, Number(v) || 1024)) })),
      field('Altura (px)', h('input', { type: 'number', value: s.height, onchange: change('height', (v) => Math.max(150, Number(v) || 600)) })),
      field('Cor de fundo', h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(s.bg) ? s.bg : '#1e2530', onchange: change('bg') }), true),
      h('label', { class: 'check full' }, h('input', { type: 'checkbox', checked: s.showInNav !== false, onchange: change('showInNav') }), 'Mostrar no menu de telas')),
    h('h4', {}, 'Como usar'),
    h('p', { class: 'hint' }, '1. Cadastre o PLC na aba "PLCs".'),
    h('p', { class: 'hint' }, '2. Crie os tags (variáveis) na aba "Tags".'),
    h('p', { class: 'hint' }, '3. Arraste objetos da paleta para a tela e escolha o tag de cada um.'),
    h('p', { class: 'hint' }, '4. Clique em "Salvar" e vá para "Operação".'),
    h('p', { class: 'hint' }, `Tela com ${s.widgets.length} objeto(s). Tamanhos comuns: 800×480 (7"), 1024×600 (10"), 1280×800, 1920×1080.`));
}
