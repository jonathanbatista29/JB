// Ponto de entrada: abas, permissões, salvar, importar/exportar.
import { state, on, h, loadMe, loadProject, saveProject, setProject, connectWs, reconnectWs, toast, can, LV } from './state.js';
import { initRuntime, show as showScreen, refreshRuntime, currentScreen } from './runtime.js';
import { initEditor, refreshEditor } from './editor.js';
import { initTags, initConnections, initAlarms, renderTags, renderConnections, renderAlarms } from './pages.js';
import { initUsers, renderUsers } from './users.js';
import { initHistory, renderHistory } from './history.js';
import { initSession, showLogin, renderUserButton, forceChangePassword } from './session.js';

const $ = (id) => document.getElementById(id);

// Nível mínimo para ver cada aba.
const PAGE_LEVEL = { runtime: LV.VIEW, alarms: LV.VIEW, history: LV.VIEW, tags: LV.MAINT, connections: LV.MAINT, editor: LV.ENG, users: LV.ADMIN };
let page = 'runtime';

function switchPage(p) {
  if (!can(PAGE_LEVEL[p] ?? LV.ADMIN)) p = 'runtime';
  page = p;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === 'page-' + p));
  if (!state.project) return;
  if (p === 'runtime') refreshRuntime();
  if (p === 'editor') refreshEditor();
  if (p === 'tags') renderTags();
  if (p === 'connections') renderConnections();
  if (p === 'alarms') renderAlarms();
  if (p === 'users') renderUsers();
  if (p === 'history') renderHistory();
}

function applyPermissions() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('hidden', !can(PAGE_LEVEL[b.dataset.page])));
  const eng = can(LV.ENG);
  $('btnSave').classList.toggle('hidden', !eng);
  $('btnImport').classList.toggle('hidden', !eng);
  $('btnExport').classList.toggle('hidden', !eng);
  $('dirtyFlag').classList.toggle('hidden', !eng || !state.dirty);
  renderUserButton($('userBox'));
}

async function save() {
  if (!can(LV.ENG)) return;
  try {
    await saveProject();
    toast('Projeto salvo e comunicação reiniciada', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function exportProject() {
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: (state.project.name || 'projeto').replace(/\W+/g, '_') + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
}

function importProject(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const p = JSON.parse(r.result);
      if (!Array.isArray(p.screens) || !Array.isArray(p.tags)) throw new Error('Arquivo não é um projeto válido');
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
    await loadProject();
  } catch (e) {
    return toast('Erro ao carregar o projeto: ' + e.message, 'err');
  }
  if (keep) setProject(keep); // não perde edições não salvas ao trocar de usuário
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
  initUsers($('page-users'));
  initHistory($('page-history'));
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

  on('dirty', (d) => $('dirtyFlag').classList.toggle('hidden', !d || !can(LV.ENG)));
  on('status', renderConnSummary);
  on('project', renderConnSummary);

  await loadMe();
  const m = location.hash.match(/tela=([^&]+)/);
  await sessionChanged();
  if (state.project) showScreen(m ? decodeURIComponent(m[1]) : currentScreen());
}

main().catch((e) => toast('Erro ao iniciar: ' + e.message, 'err'));
