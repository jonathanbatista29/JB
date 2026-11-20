// Ponto de entrada: abas, permissões, salvar, importar/exportar.
import { state, on, h, api, loadMe, loadProject, saveProject, setProject, connectWs, reconnectWs, toast, can, canEdit, isProduction, openModal, closeModal, confirmBox, LV, LEVEL_NAMES, emit } from './state.js';
import { initRuntime, show as showScreen, refreshRuntime, currentScreen, navigate as navScreen } from './runtime.js';
import { initEditor, refreshEditor } from './editor.js';
import { initTags, initConnections, initAlarms, initAlarmConfig, renderTags, renderConnections, renderAlarms, renderAlarmConfig } from './pages.js';
import { initUsers, renderUsers } from './users.js';
import { initHistory, renderHistory } from './history.js';
import { initGateway, renderGateway } from './gateway.js';
import { initTrace, initTraceConfig, renderTrace, renderTraceConfig } from './trace.js';
import { initSession, showLogin, renderUserButton, forceChangePassword, logout } from './session.js';

const $ = (id) => document.getElementById(id);

// Nível mínimo para ver cada aba.
const PAGE_LEVEL = { runtime: LV.VIEW, alarms: LV.VIEW, alarmcfg: LV.MAINT, history: LV.VIEW, tags: LV.MAINT, connections: LV.MAINT, gateway: LV.MAINT, trace: LV.VIEW, tracecfg: LV.MAINT, editor: LV.ENG, users: LV.ADMIN };
let page = 'runtime';
// Abas que somem em produção (a configuração fica travada).
const EDIT_ONLY = new Set(['editor']);
const pageAllowed = (p) => can(PAGE_LEVEL[p] ?? LV.ADMIN) && !(isProduction() && EDIT_ONLY.has(p));

function switchPage(p) {
  if (!pageAllowed(p)) p = 'runtime';
  page = p;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  document.body.classList.toggle('kiosk-page', p !== 'runtime');
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
  if (p === 'trace') renderTrace();
  if (p === 'tracecfg') renderTraceConfig();
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
  // Em produção o painel vira "modo operação": só a tela, sem a barra de cima, em tela cheia.
  document.body.classList.toggle('kiosk', isProduction() && Boolean(state.project));
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

// Sair da operação: sempre pede usuário e senha de um administrador (mesmo com outro usuário logado).
function goEdit() {
  const user = h('input', { type: 'text', autocomplete: 'username', placeholder: 'Usuário administrador', autocapitalize: 'none' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Senha' });
  const err = h('div', { class: 'form-err' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sair da operação');
  const form = h('form', { class: 'login-form', onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = '';
    try {
      await api('api/mode', { method: 'POST', body: { mode: 'edit', username: user.value.trim(), password: pass.value } });
      closeModal();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      emit('sessionChanged'); // o painel passa para o administrador
    } catch (ex) {
      err.textContent = ex.message;
      pass.value = '';
      pass.focus();
    } finally {
      btn.disabled = false;
    }
  } },
    h('h3', {}, '✎ Sair da operação para edição'),
    h('div', { class: 'note warn' }, 'Só um administrador pode tirar o projeto da operação. Todos os painéis voltam a mostrar o menu e o aviso "EDIÇÃO". A comunicação com os PLCs continua.'),
    h('label', { class: 'field' }, 'Usuário', user),
    h('label', { class: 'field' }, 'Senha', pass),
    err,
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancelar'), btn));
  openModal(form);
  setTimeout(() => user.focus(), 50);
}

// ---------- Modo operação (projeto em produção) ----------
// Sem login não opera: o painel fica pedindo o login de um usuário.
function requireOperator() {
  if (!isProduction() || state.me.user || gateOpen || !state.project) return;
  gateOpen = true;
  showLogin({ gate: true, reason: 'Painel em operação: faça login para continuar.' }).finally(() => (gateOpen = false));
}

// Menu do canto (☰): telas, páginas permitidas, trocar operador e sair da operação.
function kioskMenu() {
  const u = state.me.user;
  const go = (fn) => () => { closeModal(); fn(); };
  const screens = state.project.screens.filter((s) => s.showInNav !== false);
  const pages = [['alarms', '🔔 Alarmes'], ['trace', '🔎 Rastreabilidade'], ['history', '📊 Histórico']].filter(([p]) => pageAllowed(p));
  const full = Boolean(document.fullscreenElement);
  openModal(h('div', { class: 'kiosk-menu' },
    h('div', { class: 'kiosk-user' }, u ? ['👤 ', h('b', {}, u.name), h('small', {}, ` · ${LEVEL_NAMES[u.level] || ''}`)] : 'Ninguém logado'),
    screens.length > 1 ? [h('h4', {}, 'Telas'), h('div', { class: 'kiosk-grid' }, screens.map((s) =>
      h('button', { class: 'btn' + (s.id === currentScreen() && page === 'runtime' ? ' primary' : ''), onclick: go(() => { switchPage('runtime'); navScreen(s.id); }) }, s.name)))] : '',
    pages.length ? [h('h4', {}, 'Consultas'), h('div', { class: 'kiosk-grid' },
      page !== 'runtime' ? h('button', { class: 'btn primary', onclick: go(() => switchPage('runtime')) }, '▶ Operação') : '',
      pages.map(([p, t]) => h('button', { class: 'btn' + (p === page ? ' primary' : ''), onclick: go(() => switchPage(p)) }, t)))] : '',
    h('h4', {}, 'Painel'),
    h('div', { class: 'kiosk-grid' },
      h('button', { class: 'btn', onclick: go(() => (full ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})) }, full ? '🗗 Sair da tela cheia' : '⛶ Tela cheia'),
      u ? h('button', { class: 'btn', onclick: go(() => logout()) }, '🔄 Trocar operador') : '',
      h('button', { class: 'btn danger', onclick: go(goEdit) }, '✎ Sair da operação (admin)')),
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Fechar'))));
}

function initKiosk() {
  document.body.append(
    h('button', { class: 'kiosk-btn', title: 'Menu do painel', onclick: (e) => { e.stopPropagation(); kioskMenu(); } }, '☰'),
    h('button', { class: 'kiosk-back btn primary', onclick: () => switchPage('runtime') }, '▶ Voltar à operação'));
  // Navegadores só deixam entrar em tela cheia depois de um toque: o primeiro toque no painel já entra.
  document.addEventListener('pointerdown', () => {
    if (document.body.classList.contains('kiosk') && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, true);
}

// O modo mudou (por este painel ou por outro): ajusta abas e, em produção, abre a tela inicial.
function onModeChanged(prev) {
  applyPermissions();
  if (isProduction() && prev !== 'production') {
    if (state.dirty) { toast('Projeto entrou em produção: alterações não salvas deste painel foram descartadas', 'err'); loadProject(); }
    switchPage('runtime');
    showScreen(startScreenId());
    requireOperator();
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
  requireOperator();
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
  initTrace($('page-trace'));
  initTraceConfig($('page-tracecfg'));
  initSession({ changed: sessionChanged });
  initKiosk();

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
