// Modo operação: a tela que o operador usa no dia a dia.
import { state, on, h, ackAlarm, reportScreen, toast } from './state.js';
import { renderWidget } from './widgets.js';

let root, stage, nav, alarmBar, screenEl, clock;
let current = null;
const backStack = []; // telas anteriores, para o botão "Voltar"
const MAX_BACK = 20;
let boxes = [];

export function initRuntime(el) {
  root = el;
  nav = h('div', { class: 'rt-nav' });
  stage = h('div', { class: 'rt-stage' });
  alarmBar = h('div', { class: 'rt-alarm hidden', onclick: () => document.querySelector('[data-page=alarms]').click() });
  root.append(nav, stage, alarmBar);
  clock = h('span', { class: 'clock' });
  setInterval(() => (clock.textContent = new Date().toLocaleString('pt-BR')), 1000);

  on('project', () => show(current));
  on('me', () => { if (state.project) show(current); });
  on('values', (changed) => {
    if (!root.classList.contains('active')) return;
    for (const b of boxes) b._update();
  });
  on('alarms', renderAlarmBar);
  // Troca de tela pedida pelo PLC
  on('plcNavigate', ({ screen }) => {
    const scr = state.project?.screens.find((s) => s.id === screen);
    if (!scr || screen === current) return;
    navigate(screen);
    if (!root.classList.contains('active')) toast(`PLC abriu a tela "${scr.name}" (veja em Operação)`);
  });
  // Ao reconectar, informa de novo a tela atual
  on('status', () => { if (state.wsOnline && current && root.classList.contains('active')) reportScreen(current); });
  new ResizeObserver(fit).observe(stage);
}

export function refreshRuntime() {
  show(current);
}

// Navega guardando a tela anterior (para "Voltar").
export function navigate(id) {
  if (current && id !== current) {
    backStack.push(current);
    if (backStack.length > MAX_BACK) backStack.shift();
  }
  show(id);
}

export function back() {
  const id = backStack.pop();
  if (id) show(id);
}

export function show(id) {
  const screens = state.project?.screens || [];
  const scr = screens.find((s) => s.id === id) || screens[0];
  if (!scr) { stage.replaceChildren(); nav.replaceChildren(); return; }
  if (!scr) return;
  current = scr.id;
  location.hash = 'tela=' + encodeURIComponent(scr.id);

  nav.replaceChildren(
    ...screens.filter((s) => s.showInNav !== false).map((s) =>
      h('button', { class: s.id === scr.id ? 'active' : '', onclick: () => navigate(s.id) }, s.name)),
    clock);

  for (const b of boxes) b._destroy();
  screenEl = h('div', { class: 'screen', style: { width: scr.width + 'px', height: scr.height + 'px', background: scr.bg } });
  const rt = { runtime: true, navigate: (sid) => navigate(sid), back, current: scr.id };
  boxes = scr.widgets.map((w) => renderWidget(w, rt));
  screenEl.append(...boxes);
  stage.replaceChildren(screenEl);
  fit();
  if (root.classList.contains('active')) reportScreen(scr.id);
}

// Escala a tela para caber no espaço disponível (tablet, monitor, celular).
function fit() {
  if (!screenEl) return;
  const scr = state.project.screens.find((s) => s.id === current);
  if (!scr) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) return;
  const k = Math.min(sw / scr.width, sh / scr.height);
  screenEl.style.transform = `scale(${k})`;
  screenEl.style.position = 'absolute';
  screenEl.style.left = (sw - scr.width * k) / 2 + 'px';
  screenEl.style.top = (sh - scr.height * k) / 2 + 'px';
}

function renderAlarmBar() {
  const act = state.alarms.active || [];
  alarmBar.classList.toggle('hidden', act.length === 0);
  if (!act.length) return;
  const unacked = act.filter((a) => !a.acked).length;
  alarmBar.classList.toggle('unacked', unacked > 0);
  const last = act[0];
  alarmBar.replaceChildren(
    h('span', { class: 'count' }, String(act.length)),
    h('span', {}, '🔔 ', new Date(last.since).toLocaleTimeString('pt-BR'), ' — ', last.message),
    h('span', { style: { marginLeft: 'auto' } }),
    unacked ? h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); ackAlarm('*'); } }, `Reconhecer (${unacked})`) : '');
}

export function currentScreen() {
  return current;
}
