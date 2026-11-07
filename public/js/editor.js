// Editor de telas: arrastar objetos, redimensionar, editar propriedades.
import { state, on, h, markDirty, uid, confirmBox, toast } from './state.js';
import { WIDGETS, renderWidget, newWidget, navButton, NAVBTN_DEFAULTS, isVertical, HIDE_MODES } from './widgets.js';
import { loadImages, imagePicker, uploadFile, screenBackground, imgUrl } from './images.js';

const GRID = 10;
let root, stage, props, screenSel, zoomSel, screenEl, navPalette;
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
  for (const [type, def] of Object.entries(WIDGETS)) if (!def.hidden) (groups[def.group] ||= []).push([type, def]);
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
  navPalette = h('div');
  palette.append(navPalette);
  palette.append(h('p', { class: 'hint', style: { marginTop: '14px' } },
    'Atalhos: Del apaga, Ctrl+D duplica, Ctrl+C/V copia/cola, Ctrl+Z desfaz, setas movem (Shift = 10px). Alças nos cantos e lados redimensionam; segure Shift para manter a proporção.'));

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
  loadImages().then(() => renderProps());
}

function renderAll() {
  if (!state.project) return;
  const s = scr();
  screenId = s.id;
  const start = state.project.startScreen || state.project.screens[0]?.id;
  screenSel.replaceChildren(...state.project.screens.map((x) => h('option', { value: x.id, selected: x.id === s.id }, (x.id === start ? '★ ' : '') + x.name)));
  renderNavPalette();
  renderCanvas();
  renderProps();
}

function renderCanvas() {
  const s = scr();
  for (const b of boxes.values()) b._destroy();
  boxes = new Map();
  screenEl = h('div', { class: 'screen' + (grid ? ' grid' : ''), style: { width: s.width + 'px', height: s.height + 'px', ...screenBackground(s) } });
  for (const w of s.widgets) screenEl.append(makeBox(w));
  screenEl.addEventListener('pointerdown', onPointerDown);
  screenEl.addEventListener('dblclick', (e) => { const box = e.target.closest('.wgt'); if (box) startInlineEdit(box.dataset.id); });
  const holder = h('div', { style: { position: 'relative' } }, screenEl);
  stage.replaceChildren(holder);
  applyZoom();
}

function makeBox(w) {
  const b = renderWidget(w, { runtime: false, navigate: () => {}, current: screenId });
  boxes.set(w.id, b);
  if (w.id === selId) markSel(b);
  return b;
}

// Alças de redimensionar: 4 cantos e o meio de cada lado.
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function markSel(b) {
  b.classList.add('sel');
  for (const d of HANDLES) b.append(h('div', { class: 'rh rh-' + d, 'data-dir': d }));
}

// Calcula o novo retângulo ao arrastar uma alça. Com Shift mantém a proporção original.
function resizeRect(st, dir, dx, dy, keepRatio) {
  const right = st.x + st.w, bottom = st.y + st.h, MIN = 10;
  let x = st.x, y = st.y, w = st.w, hh = st.h;
  if (dir.includes('e')) w = snap(right + dx) - st.x;
  if (dir.includes('w')) { x = snap(st.x + dx); w = right - x; }
  if (dir.includes('s')) hh = snap(bottom + dy) - st.y;
  if (dir.includes('n')) { y = snap(st.y + dy); hh = bottom - y; }
  if (keepRatio && st.w > 0 && st.h > 0) {
    const r = st.w / st.h;
    if (dir.length === 2) {
      // canto: usa o eixo que mais mudou
      const k = Math.max(w / st.w, hh / st.h);
      w = st.w * k; hh = st.h * k;
    } else if (dir === 'e' || dir === 'w') {
      hh = w / r;
    } else {
      w = hh * r;
    }
    w = Math.max(MIN, Math.round(w)); hh = Math.max(MIN, Math.round(hh));
    if (dir.includes('w')) x = right - w;
    if (dir.includes('n')) y = bottom - hh;
    // lados: cresce para os dois lados da outra dimensão, mantendo o centro
    if (dir === 'e' || dir === 'w') y = Math.round(st.y + (st.h - hh) / 2);
    if (dir === 'n' || dir === 's') x = Math.round(st.x + (st.w - w) / 2);
  }
  if (w < MIN) { if (dir.includes('w')) x = right - MIN; w = MIN; }
  if (hh < MIN) { if (dir.includes('n')) y = bottom - MIN; hh = MIN; }
  if (x < 0) { if (dir.includes('w')) w += x; x = 0; }
  if (y < 0) { if (dir.includes('n')) hh += y; y = 0; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
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
  if (prev) { prev.classList.remove('sel'); prev.querySelectorAll('.rh').forEach((x) => x.remove()); }
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
  // Clicar na tela tira o foco de campos e caixas de seleção, para os atalhos (Ctrl+Z, Del, setas) voltarem a valer.
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName) && !e.target.closest('.inline-edit')) document.activeElement.blur();
  const box = e.target.closest('.wgt');
  if (!box) { select(null); return; }
  e.preventDefault();
  const w = scr().widgets.find((x) => x.id === box.dataset.id);
  select(w.id);
  const dir = e.target.classList.contains('rh') ? e.target.dataset.dir : null;
  const resize = Boolean(dir);
  const start = { x: e.clientX, y: e.clientY, wx: w.x, wy: w.y, ww: w.w, wh: w.h };
  let moved = false, sizeTip = null;
  const move = (ev) => {
    const dx = (ev.clientX - start.x) / zoom, dy = (ev.clientY - start.y) / zoom;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!moved) { pushUndo(); moved = true; }
    const s = scr();
    if (resize) {
      Object.assign(w, resizeRect({ x: start.wx, y: start.wy, w: start.ww, h: start.wh }, dir, dx, dy, ev.shiftKey));
      if (!sizeTip) { sizeTip = h('div', { class: 'size-tip' }); screenEl.append(sizeTip); }
      sizeTip.textContent = `${w.w} × ${w.h}${ev.shiftKey ? ' 🔒' : ''}`;
      Object.assign(sizeTip.style, { left: w.x + 'px', top: w.y + w.h + 6 + 'px' });
    } else {
      w.x = Math.max(0, Math.min(s.width - 10, snap(start.wx + dx)));
      w.y = Math.max(0, Math.min(s.height - 10, snap(start.wy + dy)));
    }
    Object.assign(box.style, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    sizeTip?.remove();
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
  const nav = e.dataTransfer.getData('text/x-navbtn');
  const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
  if ((!type && !nav && !files.length) || !screenEl) return;
  e.preventDefault();
  const r = screenEl.getBoundingClientRect();
  const x = snap((e.clientX - r.left) / zoom), y = snap((e.clientY - r.top) / zoom);
  if (files.length) return dropImages(files, x, y);
  if (nav) addNavButton(nav, x, y);
  else addWidget(type, x, y);
}

// Arquivo de imagem solto na tela: envia e cria um objeto Imagem do tamanho proporcional.
async function dropImages(files, x, y) {
  for (const f of files) {
    try {
      const file = await uploadFile(f);
      const size = await new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res([200, 150]); im.src = imgUrl(file); });
      const k = Math.min(1, 300 / Math.max(size[0], size[1], 1));
      addWidget('image', x, y, { src: file });
      const w = selW();
      if (w) { w.w = Math.max(20, Math.round(size[0] * k)); w.h = Math.max(20, Math.round(size[1] * k)); refreshBox(w); renderProps(); }
      x += 20; y += 20;
    } catch (e) { toast(e.message, 'err'); }
  }
}

let addOffset = 0;
function addWidget(type, x, y, initProps) {
  const s = scr();
  if (x == null) { addOffset = (addOffset + 20) % 200; x = 20 + addOffset; y = 80 + addOffset; }
  const w = newWidget(type, x, y);
  if (initProps) Object.assign(w.props, initProps);
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
// Próximo número de tela livre.
function nextNumber() {
  const used = new Set(state.project.screens.map((s) => Number(s.number)));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function addScreen() {
  const s = { id: uid('tela'), number: nextNumber(), name: `Tela ${state.project.screens.length + 1}`, width: scr()?.width || 1024, height: scr()?.height || 600, bg: '#1e2530', widgets: [] };
  state.project.screens.push(s);
  screenId = s.id;
  selId = null;
  markDirty();
  renderAll();
}

function dupScreen() {
  const s = structuredClone(scr());
  s.id = uid('tela');
  s.number = nextNumber();
  s.openTag = '';
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
  for (const b of state.project.navButtons || []) if (b.screen === screenId) b.screen = '';
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
    case 'image': return imagePicker(v, (val) => { set(val); renderProps(); });
    case 'screen': return h('select', { onchange: (e) => set(e.target.value) },
      h('option', { value: '' }, '— escolha —'),
      state.project.screens.map((s) => h('option', { value: s.id, selected: s.id === v }, `${s.number ?? '?'} · ${s.name}`)));
    default: return h('input', { type: 'text', value: v ?? '', onchange: (e) => set(e.target.value) });
  }
}

// ---------- Edição de texto direto na tela ----------
// Objetos com texto editável e onde o texto fica guardado.
const TEXT_TYPES = { label: 'left', button: 'center', lamp: 'left', navbtn: 'center' };
function textTarget(w) {
  if (!(w.type in TEXT_TYPES)) return null;
  if (w.type === 'navbtn') { const b = navButton(w.props.ref); return b ? { obj: b, shared: true } : null; }
  return { obj: w.props, shared: false };
}

let inlineEditor = null;
function startInlineEdit(id) {
  const w = scr().widgets.find((x) => x.id === id);
  const t = w && textTarget(w);
  if (!t) return toast('Este objeto não tem texto para editar');
  closeInlineEdit(true);
  select(id);
  const align = w.type === 'label' ? w.props.align || 'left' : TEXT_TYPES[w.type];
  // Texto vertical: edita na horizontal (mais fácil de ler), numa caixa com as medidas trocadas.
  const vert = isVertical(w.props.rotate);
  const [ew, eh] = vert ? [Math.max(w.h, 120), Math.max(w.w, 36)] : [Math.max(w.w, 80), Math.max(w.h, 36)];
  const ta = h('textarea', { class: 'inline-edit', spellcheck: 'false', style: {
    left: w.x + 'px', top: w.y + 'px', width: ew + 'px', height: eh + 'px',
    fontSize: (Number(t.obj.fontSize) || 16) + 'px', textAlign: align,
  } }, t.obj.text ?? '');
  const hint = h('div', { class: 'inline-hint', style: { left: w.x + 'px', top: w.y + eh + 4 + 'px' } },
    'Enter confirma · Shift+Enter nova linha · Esc cancela');
  const done = (save) => {
    if (inlineEditor !== editor) return;
    inlineEditor = null;
    ta.remove(); hint.remove();
    if (!save || ta.value === (t.obj.text ?? '')) return;
    if (!t.shared) pushUndo();
    t.obj.text = ta.value;
    markDirty();
    if (t.shared) { renderCanvas(); renderNavPalette(); } else refreshBox(w);
    renderProps();
  };
  const editor = { done };
  inlineEditor = editor;
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  ta.addEventListener('blur', () => done(true));
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  screenEl.append(ta, hint);
  ta.focus();
  ta.select();
}

function closeInlineEdit(save) {
  inlineEditor?.done(save);
}

// ---------- Botões de tela (biblioteca) ----------
const lib = () => (state.project.navButtons ||= []);
const screenName = (id) => state.project.screens.find((s) => s.id === id)?.name;
const usesOf = (id) => state.project.screens.reduce((n, s) => n + s.widgets.filter((w) => w.type === 'navbtn' && w.props?.ref === id).length, 0);

// Cria um botão novo na biblioteca com o próximo número da sequência.
function createNavButton(screen = '') {
  const used = new Set(lib().map((b) => Number(b.number)));
  let n = 1;
  while (used.has(n)) n++;
  const name = screenName(screen) || `Botão de tela ${n}`;
  const b = { ...NAVBTN_DEFAULTS, id: uid('nb'), number: n, name, text: name.toUpperCase(), screen };
  lib().push(b);
  markDirty();
  renderNavPalette();
  return b;
}

// Coloca um botão da biblioteca na tela ('new' cria um novo).
function addNavButton(ref, x, y) {
  const b = ref === 'new' ? createNavButton() : navButton(ref);
  if (!b) return;
  addWidget('navbtn', x, y, { ref: b.id });
  renderNavPalette();
}

function renderNavPalette() {
  if (!navPalette) return;
  const item = (ref, content, cls = '') => h('div', {
    class: 'pal-item pal-nav ' + cls, draggable: 'true', title: 'Arraste para a tela ou clique para adicionar',
    ondragstart: (e) => e.dataTransfer.setData('text/x-navbtn', ref),
    onclick: () => addNavButton(ref),
  }, ...content);
  navPalette.replaceChildren(
    h('h4', {}, 'Botões de tela'),
    item('new', [h('span', { class: 'ic' }, '＋'), 'Novo botão de tela'], 'new'),
    ...[...lib()].sort((a, b) => a.number - b.number).map((b) => item(b.id, [
      h('span', { class: 'num' }, String(b.number)),
      h('span', {}, b.name, h('small', {}, '→ ' + (screenName(b.screen) || 'sem tela'))),
    ])));
}

// Painel de propriedades de um botão de tela: as alterações valem para todas as cópias.
function renderNavButtonProps(w) {
  const b = navButton(w.props.ref);
  const refSel = h('select', { onchange: (e) => {
    pushUndo();
    if (e.target.value === 'new') w.props.ref = createNavButton().id;
    else w.props.ref = e.target.value;
    markDirty(); refreshBox(w); renderProps();
  } },
    !b ? h('option', { value: '', selected: true }, '(botão excluído)') : '',
    [...lib()].sort((x, y) => x.number - y.number).map((x) => h('option', { value: x.id, selected: x.id === w.props.ref }, `${x.number} · ${x.name}`)),
    h('option', { value: 'new' }, '+ Criar novo botão'));
  const geo = (key, label) => h('label', { class: 'field' }, label, h('input', {
    type: 'number', value: w[key], onchange: (e) => { pushUndo(); w[key] = Math.max(key === 'w' || key === 'h' ? 10 : 0, Number(e.target.value) || 0); markDirty(); refreshBox(w); },
  }));
  const actions = h('div', { class: 'prop-actions' },
    b ? h('button', { class: 'btn small primary', onclick: () => startInlineEdit(w.id) }, '✎ Editar texto na tela') : '',
    h('button', { class: 'btn small', onclick: () => duplicate() }, 'Duplicar'),
    h('button', { class: 'btn small', onclick: () => reorder(true) }, 'Trazer p/ frente'),
    h('button', { class: 'btn small', onclick: () => reorder(false) }, 'Enviar p/ trás'),
    h('button', { class: 'btn small danger', onclick: deleteSel }, 'Tirar desta tela'));
  if (!b) {
    return props.replaceChildren(h('h4', {}, '⇨ Botão de tela'), field('Botão da biblioteca', refSel, true), actions);
  }
  // Edita a definição na biblioteca e redesenha todas as cópias desta tela.
  const libChange = (key, conv = (x) => x) => (e) => {
    b[key] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    markDirty();
    renderCanvas();
    renderNavPalette();
    if (key === 'screen' || key === 'name') renderProps();
  };
  const color = (key, label) => field(label, h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(b[key]) ? b[key] : '#000000', oninput: libChange(key) }));
  const uses = usesOf(b.id);
  props.replaceChildren(
    h('h4', {}, `⇨ Botão de tela nº ${b.number}`),
    h('div', { class: 'prop-grid' },
      field('Botão da biblioteca', refSel, true),
      geo('x', 'X'), geo('y', 'Y'), geo('w', 'Largura'), geo('h', 'Altura')),
    h('div', { class: 'vis-fields' }, visFields(w)),
    h('h4', {}, 'Definição do botão'),
    h('div', { class: 'lib-note' }, `Usado ${uses} vez(es) no projeto. Mudanças aqui valem para todas as cópias.`),
    h('div', { class: 'prop-grid', style: { marginTop: '8px' } },
      field('Nome (na paleta)', h('input', { type: 'text', value: b.name, onchange: libChange('name') }), true),
      field('Texto do botão (Enter = nova linha)', h('textarea', { rows: 2, onchange: libChange('text') }, b.text ?? ''), true),
      field('Abre a tela', h('select', { onchange: libChange('screen') },
        h('option', { value: '' }, '— escolha —'),
        state.project.screens.map((x) => h('option', { value: x.id, selected: x.id === b.screen }, `${x.number ?? '?'} · ${x.name}`))), true),
      color('bg', 'Cor de fundo'), color('color', 'Cor do texto'),
      field('Fonte (px)', h('input', { type: 'number', value: b.fontSize, onchange: libChange('fontSize', Number) })),
      field('Nível mínimo', h('select', { onchange: libChange('level') },
        [['', 'Todos'], ['1', 'Operador'], ['2', 'Manutenção'], ['3', 'Engenharia'], ['4', 'Administrador']].map(([v, t]) => h('option', { value: v, selected: String(b.level ?? '') === v }, t))))),
    actions,
    h('div', { class: 'prop-actions' },
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!(await confirmBox(`Excluir o botão "${b.name}" da biblioteca? Ele sai de ${uses} lugar(es).`))) return;
        pushUndo();
        state.project.navButtons = lib().filter((x) => x !== b);
        for (const s2 of state.project.screens) s2.widgets = s2.widgets.filter((x) => !(x.type === 'navbtn' && x.props?.ref === b.id));
        selId = null;
        markDirty();
        renderAll();
      } }, 'Excluir da biblioteca')));
}

// Seção "Visibilidade": o objeto some na operação quando o tag liga, desliga ou tem um valor.
function visFields(w) {
  const p = w.props ||= {};
  const set = (k, rerender) => (e) => {
    pushUndo();
    p[k] = e.target.value;
    markDirty();
    refreshBox(w);
    if (rerender) renderProps();
  };
  const tags = state.project.tags;
  const tagSel = h('select', { onchange: set('hideTag', true) }, h('option', { value: '' }, '— nenhum —'),
    tags.map((t) => h('option', { value: t.name, selected: t.name === p.hideTag }, `${t.name}${t.description ? ' — ' + t.description : ''}`)));
  if (p.hideTag && !tags.some((t) => t.name === p.hideTag)) tagSel.append(h('option', { value: p.hideTag, selected: true }, `${p.hideTag} (não existe!)`));
  const modeSel = h('select', { onchange: set('hideMode', true) }, HIDE_MODES.map(([v, t]) => h('option', { value: v, selected: v === (p.hideMode || '') }, t)));
  const needValue = p.hideMode === 'eq' || p.hideMode === 'neq';
  return [
    h('h4', {}, 'Visibilidade'),
    h('div', { class: 'prop-grid' },
      field('Regra', modeSel, true),
      p.hideMode ? field('Tag', tagSel, true) : '',
      p.hideMode && needValue ? field('Valor (vários: 1, 3, 5)', h('input', { type: 'text', value: p.hideValue ?? '', placeholder: 'ex.: 2', onchange: set('hideValue') }), true) : ''),
    p.hideMode ? h('div', { class: 'lib-note' }, 'Na operação o objeto some (e não pode ser clicado). No editor ele fica apagado. Sem comunicação com o tag, continua visível.') : '',
  ];
}

function renderProps() {
  const w = selW();
  if (!w) return renderScreenProps();
  if (w.type === 'navbtn') return renderNavButtonProps(w);
  const def = WIDGETS[w.type];
  const onChange = (pd) => {
    // Texto passou para vertical (ou voltou): troca largura e altura para o texto caber.
    if (pd.key === 'rotate') {
      const v = isVertical(w.props.rotate);
      if ((v && w.w > w.h) || (!v && w.h > w.w)) [w.w, w.h] = [w.h, w.w];
    }
    markDirty();
    refreshBox(w);
    if (pd.kind === 'select' || pd.kind === 'bool' || pd.kind === 'tag') renderProps();
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
    h('div', { class: 'vis-fields' }, visFields(w)),
    h('div', { class: 'prop-actions' },
      textTarget(w) ? h('button', { class: 'btn small primary', onclick: () => startInlineEdit(w.id) }, '✎ Editar texto na tela') : '',
      h('button', { class: 'btn small', onclick: () => duplicate() }, 'Duplicar'),
      h('button', { class: 'btn small', onclick: () => reorder(true) }, 'Trazer p/ frente'),
      h('button', { class: 'btn small', onclick: () => reorder(false) }, 'Enviar p/ trás'),
      h('button', { class: 'btn small danger', onclick: deleteSel }, 'Excluir')));
}

// Na configuração da tela: qual botão da biblioteca chama esta tela.
function callButtonProps(s) {
  const linked = lib().filter((b) => b.screen === s.id);
  const sel = h('select', { onchange: (e) => {
    const v = e.target.value;
    if (v === 'new') createNavButton(s.id);
    else if (v) navButton(v).screen = s.id;
    markDirty(); renderCanvas(); renderNavPalette(); renderProps();
  } },
    h('option', { value: '' }, linked.length ? '— ligar outro botão —' : '— escolha —'),
    [...lib()].filter((b) => b.screen !== s.id).sort((a, b) => a.number - b.number)
      .map((b) => h('option', { value: b.id }, `${b.number} · ${b.name}${b.screen ? ' (hoje abre ' + (screenName(b.screen) || '?') + ')' : ''}`)),
    h('option', { value: 'new' }, '+ Criar botão para esta tela'));
  return [
    h('h4', {}, 'Botão de chamada desta tela'),
    linked.length
      ? h('div', { class: 'lib-note' }, 'Esta tela é aberta por: ', linked.map((b, i) => [i ? ', ' : '', h('b', {}, `${b.number} · ${b.name}`)]))
      : h('p', { class: 'hint' }, 'Nenhum botão chama esta tela ainda.'),
    h('div', { class: 'prop-grid', style: { marginTop: '8px' } }, field('Botão', sel, true)),
    h('p', { class: 'hint' }, 'Depois arraste o botão da paleta ("Botões de tela") para as telas onde ele deve aparecer.'),
  ];
}

const INT_TYPES = ['int16', 'uint16', 'int32', 'uint32'];

// Seleção de tag filtrada por tipo.
function tagSelect(value, types, onchange) {
  const tags = state.project.tags.filter((t) => types.includes(t.type));
  const sel = h('select', { onchange: (e) => onchange(e.target.value) },
    h('option', { value: '' }, '— nenhum —'),
    tags.map((t) => h('option', { value: t.name, selected: t.name === value }, `${t.name} (${t.type.toUpperCase()})`)));
  if (value && !tags.some((t) => t.name === value)) sel.append(h('option', { value, selected: true }, `${value} (tipo inválido ou não existe!)`));
  return sel;
}

// Campos de troca de tela pelo PLC: por número (projeto) e por bit (esta tela).
function navProps(s) {
  const nav = (state.project.navigation ||= { requestTag: '', resetRequest: false, currentTag: '' });
  const dirty = () => { markDirty(); renderProps(); };
  const numIn = h('input', { type: 'number', min: 1, value: s.number ?? '', onchange: (e) => {
    const n = Math.floor(Number(e.target.value));
    if (!(n >= 1)) { toast('Número inválido', 'err'); e.target.value = s.number ?? ''; return; }
    const other = state.project.screens.find((x) => x !== s && Number(x.number) === n);
    if (other) { toast(`O número ${n} já é da tela "${other.name}"`, 'err'); e.target.value = s.number ?? ''; return; }
    s.number = n;
    dirty();
  } });
  return [
    h('h4', {}, 'Chamada da tela pelo PLC'),
    h('div', { class: 'prop-grid' },
      field('Número da tela', numIn),
      h('div', { class: 'hint', style: { alignSelf: 'end' } }, 'Usado pela chamada por INT/DINT.'),
      field('Abrir quando este BOOL ligar', tagSelect(s.openTag, ['bool'], (v) => { s.openTag = v; dirty(); }), true),
      h('label', { class: 'check full' }, h('input', { type: 'checkbox', checked: Boolean(s.resetOpenTag), disabled: !s.openTag,
        onchange: (e) => { s.resetOpenTag = e.target.checked; markDirty(); } }), 'Desligar o bit depois de abrir a tela')),
    h('h4', {}, 'Chamada por número (todas as telas)'),
    h('div', { class: 'prop-grid' },
      field('Tag com o nº da tela a abrir (INT/DINT)', tagSelect(nav.requestTag, INT_TYPES, (v) => { nav.requestTag = v; dirty(); }), true),
      h('label', { class: 'check full' }, h('input', { type: 'checkbox', checked: Boolean(nav.resetRequest), disabled: !nav.requestTag,
        onchange: (e) => { nav.resetRequest = e.target.checked; markDirty(); } }), 'Zerar o tag depois de trocar de tela'),
      field('Tag que recebe o nº da tela atual (INT/DINT)', tagSelect(nav.currentTag, INT_TYPES, (v) => { nav.currentTag = v; dirty(); }), true)),
    h('p', { class: 'hint' }, 'Ex.: o PLC escreve 2 no tag de número e todos os painéis abrem a tela nº 2. ' +
      'Botões também podem abrir telas (ação "Ir para outra tela" ou "Voltar à tela anterior").'),
  ];
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
      field('Imagem de fundo', imagePicker(s.bgImage || '', (v) => { s.bgImage = v; markDirty(); renderCanvas(); renderProps(); }), true),
      s.bgImage ? field('Ajuste do fundo', h('select', { onchange: change('bgFit') },
        [['cover', 'Preencher a tela'], ['contain', 'Caber inteira'], ['stretch', 'Esticar']].map(([v, t]) => h('option', { value: v, selected: (s.bgFit || 'cover') === v }, t))), true) : '',
      h('label', { class: 'check full' }, h('input', { type: 'checkbox', checked: s.showInNav !== false, onchange: change('showInNav') }), 'Mostrar no menu de telas'),
      h('label', { class: 'check full', title: 'Abre ao colocar o projeto em produção e quando um painel é aberto em produção' },
        h('input', { type: 'checkbox', checked: (state.project.startScreen || state.project.screens[0]?.id) === s.id,
          onchange: (e) => { state.project.startScreen = e.target.checked ? s.id : state.project.screens[0].id; markDirty(); renderAll(); } }),
        '★ Tela inicial (abre ao colocar em produção)')),
    ...callButtonProps(s),
    ...navProps(s),
    h('h4', {}, 'Como usar'),
    h('p', { class: 'hint' }, '1. Cadastre o PLC na aba "PLCs".'),
    h('p', { class: 'hint' }, '2. Crie os tags (variáveis) na aba "Tags".'),
    h('p', { class: 'hint' }, '3. Arraste objetos da paleta para a tela e escolha o tag de cada um.'),
    h('p', { class: 'hint' }, '4. Clique em "Salvar" e vá para "Operação".'),
    h('p', { class: 'hint' }, `Tela com ${s.widgets.length} objeto(s). Tamanhos comuns: 800×480 (7"), 1024×600 (10"), 1280×800, 1920×1080.`));
}
