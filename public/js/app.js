// Ponto de entrada: abas, permissões, salvar, importar/exportar.
import { state, on, h, api, loadMe, loadProject, saveProject, setProject, connectWs, reconnectWs, toast, can, canEdit, isProduction, openModal, closeModal, confirmBox, LV } from './state.js';
import { initRuntime, show as showScreen, refreshRuntime, currentScreen } from './runtime.js';
import { initEditor, refreshEditor } from './editor.js';
import { initTags, initConnections, initAlarms, initAlarmConfig, renderTags, renderConnections, renderAlarms, renderAlarmConfig } from './pages.js';
import { initUsers, renderUsers } from './users.js';
import { initHistory, renderHistory } from './history.js';
import { initGateway, renderGateway } from './gateway.js';
import { initSession, showLogin, renderUserButton, forceChangePassword } from './session.js';

const $ = (id) => document.getElementById(id);

// Nível mínimo para ver cada aba.
const PAGE_LEVEL = { runtime: LV.VIEW, alarms: LV.VIEW, alarmcfg: LV.MAINT, history: LV.VIEW, tags: LV.MAINT, connections: LV.MAINT, gateway: LV.MAINT, editor: LV.ENG, users: LV.ADMIN };
let page = 'runtime';
// Abas que somem em produção (a configuração fica travada).
const EDIT_ONLY = new Set(['editor']);
const pageAllowed = (p) => can(PAGE_LEVEL[p] ?? LV.ADMIN) && !(isProduction() && EDIT_ONLY.has(p));

function switchPage(p) {
  if (!pageAllowed(p)) p = 'runtime';
  page = p;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === 'page-' + p));
  if (!state.project) return;
  if (p === 'runtime') refreshRuntime();
  if (p === 'editor') refreshEditor();
  if (p === 'tags') renderTags();
  if (p === 'connections') renderConnections();
  if (p === 'alarms') renderAlarms();
  if (p === 'alarmcfg') renderAlarmConfig();
  if (p === 'users') renderUsers();
  if (p === 'history') renderHistory();
  if (p === 'gateway') renderGateway();
}

function applyPermissions() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('hidden', !pageAllowed(b.dataset.page)));
  const edit = canEdit();
  $('btnSave').classList.toggle('hidden', !edit);
  $('btnImport').classList.toggle('hidden', !edit);
  $('btnExport').classList.toggle('hidden', !can(LV.ENG));
  $('dirtyFlag').classList.toggle('hidden', !edit || !state.dirty);
  document.body.classList.toggle('mode-production', isProduction());
  document.body.classList.toggle('mode-edit', !isProduction());
  renderModeBox();
  renderUserButton($('userBox'));
}

// ---------- Modo edição / produção ----------
function renderModeBox() {
  const prod = isProduction();
  const badge = h('span', { class: 'mode-badge ' + (prod ? 'prod' : 'edit'),
    title: prod ? 'Projeto em produção: configuração travada' : 'Projeto em edição: telas e configuração podem ser alteradas' },
    prod ? '● PRODUÇÃO' : '✎ EDIÇÃO');
  const btn = !can(LV.ENG) || !state.project ? ''
    : prod
      ? h('button', { class: 'btn small', onclick: goEdit, title: 'Voltar para o modo edição' }, '✎ Editar')
      : h('button', { class: 'btn small run-btn', onclick: goProduction, title: 'Colocar o projeto em produção' }, '▶ Produção');
  $('modeBox').replaceChildren(badge, btn);
}

async function loadMode() {
  try { state.mode = await api('api/mode'); } catch { state.mode = { mode: 'edit' }; }
}

function startScreenId() {
  const p = state.project;
  const id = state.mode.startScreen || p.startScreen;
  return p.screens.some((s) => s.id === id) ? id : p.screens[0]?.id;
}

// Alerta antes de colocar em produção: escolhe a tela inicial e confirma.
function goProduction() {
  const p = state.project;
  const sel = h('select', {}, p.screens.map((s) => h('option', { value: s.id, selected: s.id === startScreenId() }, `${s.number ?? ''} · ${s.name}`)));
  const online = p.connections.filter((c) => state.status[c.id]?.state === 'online').length;
  const offline = p.connections.filter((c) => c.enabled !== false && state.status[c.id]?.state !== 'online');
  const go = async () => {
    btnOk.disabled = true;
    try {
      // Salva antes (alterações pendentes e a tela inicial escolhida) e depois troca o modo.
      if (state.dirty || p.startScreen !== sel.value) {
        p.startScreen = sel.value;
        await saveProject();
      }
      await api('api/mode', { method: 'POST', body: { mode: 'production' } });
      closeModal();
    } catch (e) {
      toast(e.message, 'err');
      btnOk.disabled = false;
    }
  };
  const btnOk = h('button', { class: 'btn run-btn', onclick: go }, state.dirty ? '💾 Salvar e colocar em produção' : '▶ Colocar em produção');
  openModal(h('div', { class: 'mode-dialog' },
    h('h3', {}, '⚠ Colocar em produção'),
    h('div', { class: 'note warn' },
      'Em produção a edição de telas, tags, PLCs, gateway e alarmes fica ', h('b', {}, 'travada para todos'),
      '. Todos os painéis abertos deste projeto vão para a tela inicial.'),
    state.dirty ? h('div', { class: 'note warn' }, 'Há alterações não salvas: elas serão salvas antes de entrar em produção.') : '',
    h('label', { class: 'field' }, 'Tela inicial', sel),
    h('ul', { class: 'mode-summary' },
      h('li', {}, `Projeto: ${p.name}`),
      h('li', {}, `${p.screens.length} tela(s), ${p.tags.length} tag(s)`),
      h('li', {}, `Conexões online: ${online} de ${p.connections.length}`),
      offline.length ? h('li', { class: 'prio-alta' }, `Sem comunicação: ${offline.map((c) => c.name).join(', ')}`) : '',
      state.alarms.active?.length ? h('li', { class: 'prio-media' }, `${state.alarms.active.length} alarme(s) ativo(s)`) : ''),
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancelar'), btnOk)));
}

async function goEdit() {
  if (!(await confirmBox('Voltar para o modo edição? A operação e a comunicação com os PLCs continuam, mas o projeto poderá ser alterado. Os painéis mostrarão o aviso "EDIÇÃO".'))) return;
  try { await api('api/mode', { method: 'POST', body: { mode: 'edit' } }); } catch (e) { toast(e.message, 'err'); }
}

// O modo mudou (por este painel ou por outro): ajusta abas e, em produção, abre a tela inicial.
function onModeChanged(prev) {
  applyPermissions();
  if (isProduction() && prev !== 'production') {
    if (state.dirty) { toast('Projeto entrou em produção: alterações não salvas deste painel foram descartadas', 'err'); loadProject(); }
    switchPage('runtime');
    showScreen(startScreenId());
    toast(`Projeto em produção — tela inicial: ${state.project.screens.find((s) => s.id === startScreenId())?.name}`, 'ok');
  } else if (!isProduction() && prev === 'production') {
    toast('Projeto voltou para o modo edição');
    switchPage(page);
  }
}

async function save() {
  if (!canEdit()) return;
  try {
    await saveProject();
    toast('Projeto salvo e comunicação reiniciada', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// Backup completo (configuração + imagens) gerado pelo servidor.
function exportProject() {
  const slug = location.pathname.split('/').filter(Boolean)[0];
  if (state.dirty) toast('Atenção: o backup contém a última versão SALVA do projeto', 'err');
  location.href = `/api/projects/${encodeURIComponent(slug)}/export`;
}

function importProject(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const data = JSON.parse(r.result);
      const p = data?.jbihm === 'projeto' ? data.project : data;
      if (!Array.isArray(p?.screens) || !Array.isArray(p?.tags)) throw new Error('Arquivo não é um projeto válido');
      for (const [file, img] of Object.entries(data?.images || {})) {
        await api('api/images', { method: 'POST', body: { file, name: file, data: img } });
      }
      p.connections ||= [];
      p.alarms ||= [];
      setProject(p);
      toast('Projeto importado. Clique em Salvar para aplicar.', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  r.readAsText(file);
}

function renderConnSummary() {
  const el = $('connSummary');
  const items = (state.project?.connections || []).map((c) => {
    const st = state.status[c.id];
    return h('span', { class: 'dot ' + (st?.state || ''), title: `${c.name}: ${st ? st.state + (st.error ? ' — ' + st.error : '') : '—'}` });
  });
  if (!state.wsOnline && state.me.level >= LV.VIEW) items.unshift(h('span', { class: 'dirty' }, 'servidor offline'));
  el.replaceChildren(...items);
}

// Chamado no início e sempre que o usuário entra, sai ou tem o acesso alterado.
let gateOpen = false;
async function sessionChanged() {
  applyPermissions();
  if (state.me.user?.mustChange) {
    await forceChangePassword();
    return;
  }
  if (state.me.level < LV.VIEW) {
    // Sem acesso sem login: mostra só a tela de login.
    document.body.classList.add('locked');
    state.project = null;
    if (!gateOpen) {
      gateOpen = true;
      showLogin({ gate: true }).finally(() => (gateOpen = false));
    }
    return;
  }
  document.body.classList.remove('locked');
  const keep = state.dirty && can(LV.ENG) ? state.project : null;
  try {
    await Promise.all([loadProject(), loadMode()]);
  } catch (e) {
    return toast('Erro ao carregar o projeto: ' + e.message, 'err');
  }
  if (keep) setProject(keep); // não perde edições não salvas ao trocar de usuário
  $('projName').textContent = '⌂ ' + state.project.name;
  document.title = `${state.project.name} — JB IHM`;
  applyPermissions();
  reconnectWs();
  switchPage(page);
}

async function main() {
  initRuntime($('page-runtime'));
  initEditor($('page-editor'), { onTest: (id) => { switchPage('runtime'); showScreen(id); } });
  initTags($('page-tags'));
  initConnections($('page-connections'));
  initAlarms($('page-alarms'));
  initAlarmConfig($('page-alarmcfg'));
  initUsers($('page-users'));
  initHistory($('page-history'));
  initGateway($('page-gateway'));
  initSession({ changed: sessionChanged });

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchPage(b.dataset.page); });
  $('btnSave').addEventListener('click', save);
  $('btnMenu').addEventListener('click', (e) => { e.stopPropagation(); $('menuList').classList.toggle('hidden'); });
  $('btnExport').addEventListener('click', exportProject);
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', (e) => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; });
  $('btnFullscreen').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
  $('modal').addEventListener('pointerdown', (e) => {
    if (e.target.id === 'modal' && !$('modal').dataset.locked && !document.querySelector('.keypad')) $('modal').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
  window.addEventListener('beforeunload', (e) => { if (state.dirty && can(LV.ENG)) { e.preventDefault(); e.returnValue = ''; } });

  on('dirty', (d) => $('dirtyFlag').classList.toggle('hidden', !d || !canEdit()));
  // Outro painel salvou o projeto: recarrega (sem perder edições locais não salvas).
  on('projectSaved', async () => {
    if (state.dirty) return toast('O projeto foi salvo por outro usuário. Recarregue para ver as mudanças.', 'err');
    const cur = currentScreen();
    try { await loadProject(); } catch { return; }
    applyPermissions();
    if (cur) showScreen(cur);
  });
  let lastMode = null;
  on('mode', () => { const prev = lastMode; lastMode = state.mode.mode; if (prev !== null && prev !== lastMode) onModeChanged(prev); else applyPermissions(); });
  on('status', renderConnSummary);
  on('project', renderConnSummary);

  await loadMe();
  const m = location.hash.match(/tela=([^&]+)/);
  await sessionChanged();
  // Em produção o painel sempre abre na tela inicial; em edição, na última tela aberta.
  if (state.project) showScreen(isProduction() ? startScreenId() : m ? decodeURIComponent(m[1]) : currentScreen());
}

main().catch((e) => toast('Erro ao iniciar: ' + e.message, 'err'));
