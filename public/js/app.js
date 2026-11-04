// Ponto de entrada: abas, salvar, importar/exportar.
import { state, on, h, loadProject, saveProject, setProject, connectWs, toast } from './state.js';
import { initRuntime, show as showScreen, refreshRuntime, currentScreen } from './runtime.js';
import { initEditor, refreshEditor } from './editor.js';
import { initTags, initConnections, initAlarms, renderTags } from './pages.js';

const $ = (id) => document.getElementById(id);

function switchPage(page) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  if (page === 'runtime') refreshRuntime();
  if (page === 'editor') refreshEditor();
  if (page === 'tags') renderTags();
}

async function save() {
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
  if (!state.wsOnline) items.unshift(h('span', { class: 'dirty' }, 'servidor offline'));
  el.replaceChildren(...items);
}

async function main() {
  initRuntime($('page-runtime'));
  initEditor($('page-editor'), { onTest: (id) => { switchPage('runtime'); showScreen(id); } });
  initTags($('page-tags'));
  initConnections($('page-connections'));
  initAlarms($('page-alarms'));

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchPage(b.dataset.page); });
  $('btnSave').addEventListener('click', save);
  $('btnMenu').addEventListener('click', (e) => { e.stopPropagation(); $('menuList').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('menuList').classList.add('hidden'));
  $('btnExport').addEventListener('click', exportProject);
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', (e) => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; });
  $('btnFullscreen').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
  $('modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal' && !document.querySelector('.keypad')) $('modal').classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  on('dirty', (d) => $('dirtyFlag').classList.toggle('hidden', !d));
  on('status', renderConnSummary);
  on('project', renderConnSummary);

  await loadProject();
  const m = location.hash.match(/tela=([^&]+)/);
  showScreen(m ? decodeURIComponent(m[1]) : currentScreen());
  connectWs();
}

main().catch((e) => toast('Erro ao iniciar: ' + e.message, 'err'));
