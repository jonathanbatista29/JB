// Página inicial: lista de projetos (IHMs), criação, backup e restauração.
import { state, h, api, loadMe, toast, confirmBox, openModal, closeModal, can, LV } from './state.js';
import { initSession, showLogin, renderUserButton, forceChangePassword } from './session.js';

const $ = (id) => document.getElementById(id);
const root = $('root');
let refreshTimer = null;

const urlOf = (slug) => `${location.origin}/${slug}/`;
const fmtDate = (t) => new Date(t).toLocaleString('pt-BR');

async function main() {
  initSession({ changed: render });
  $('modal').addEventListener('pointerdown', (e) => {
    if (e.target.id === 'modal' && !$('modal').dataset.locked) closeModal();
  });
  await loadMe();
  await render();
}

async function render() {
  renderUserButton($('userBox'));
  if (state.me.user?.mustChange) return forceChangePassword();
  if (state.me.level < LV.VIEW) {
    root.replaceChildren(h('p', { class: 'hint' }, 'Faça login para ver os projetos.'));
    return showLogin({ gate: true });
  }
  let list;
  try {
    list = await api('api/projects');
  } catch (e) {
    return root.replaceChildren(h('p', { class: 'hint' }, e.message));
  }
  const eng = can(LV.ENG), admin = can(LV.ADMIN);
  root.replaceChildren(
    h('div', { class: 'head' },
      h('h2', {}, `Projetos (${list.length})`),
      eng ? h('button', { class: 'btn primary', onclick: newProject }, '+ Novo projeto') : '',
      eng ? h('button', { class: 'btn', onclick: () => pickFile(importProject) }, 'Importar projeto') : '',
      admin ? h('button', { class: 'btn', onclick: () => (location.href = 'api/backup') }, '⬇ Backup geral') : '',
      admin ? h('button', { class: 'btn', onclick: () => pickFile(restoreAll) }, 'Restaurar backup geral') : ''),
    h('p', { class: 'hint', style: { margin: 0 } },
      'Cada projeto é uma IHM separada, com as próprias telas, PLCs, tags, gateway, alarmes e histórico. Todos rodam ao mesmo tempo. ',
      'Abra pelo endereço mostrado em cada cartão.'),
    h('div', { class: 'cards' }, list.map((p) => card(p, eng, admin))));
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if ($('modal').classList.contains('hidden')) render(); }, 5000);
}

function card(p, eng, admin) {
  const url = urlOf(p.slug);
  const online = p.connections.filter((c) => c.state === 'online').length;
  return h('div', { class: 'card proj-card' },
    h('h3', {}, p.name),
    h('div', { class: 'url' }, url),
    h('div', { class: 'stats' },
      h('span', {}, `${p.screens} tela(s)`), h('span', {}, `${p.tags} tag(s)`),
      h('span', {}, `${online}/${p.connections.length} conexão(ões) online`),
      p.activeAlarms ? h('span', { class: 'prio-alta' }, `🔔 ${p.activeAlarms} alarme(s)`) : '',
      h('span', {}, `${p.clients} painel(is) aberto(s)`)),
    p.connections.length ? h('div', { class: 'conns' }, p.connections.map((c) =>
      h('span', { title: c.error || '' }, h('span', { class: 'dot ' + c.state }), ' ', c.name))) : '',
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary', href: `/${p.slug}/` }, '▶ Abrir'),
      h('button', { class: 'btn small', onclick: () => copy(url) }, 'Copiar endereço'),
      eng ? h('button', { class: 'btn small', onclick: () => renameProject(p) }, 'Renomear') : '',
      eng ? h('button', { class: 'btn small', onclick: () => duplicateProject(p) }, 'Duplicar') : ''),
    eng ? h('div', { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => (location.href = `api/projects/${p.slug}/export`) }, '⬇ Backup do projeto'),
      h('button', { class: 'btn small', onclick: () => (location.href = `api/projects/${p.slug}/history-db`) }, '⬇ Histórico (.db)'),
      h('button', { class: 'btn small', onclick: () => showVersions(p) }, '🕘 Versões salvas'),
      admin ? h('button', { class: 'btn small danger', onclick: () => deleteProject(p) }, 'Excluir') : '') : '');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Endereço copiado', 'ok');
  } catch {
    prompt('Copie o endereço:', text);
  }
}

// Formulário simples com nome (+ opções).
function askName({ title, label = 'Nome do projeto', value = '', extra = null, ok = 'Criar' }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder: 'ex.: Estação 1' });
    const preview = h('div', { class: 'hint' });
    const upd = () => (preview.textContent = 'Endereço: ' + urlOf(slugPreview(input.value)));
    input.addEventListener('input', upd);
    upd();
    const done = (v) => { closeModal(); resolve(v); };
    openModal(h('form', { class: 'login-form', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) done({ name: input.value.trim(), extra: extra?.value }); } },
      h('h3', {}, title),
      h('label', { class: 'field' }, label, input),
      ok === 'Renomear' ? h('div', { class: 'hint' }, 'O endereço do projeto não muda ao renomear.') : preview,
      extra ? extra.el : '',
      h('div', { class: 'confirm-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancelar'),
        h('button', { class: 'btn primary', type: 'submit' }, ok))));
    setTimeout(() => input.focus(), 50);
  });
}

// Mesmo cálculo do servidor (o servidor ainda acrescenta -2, -3... se o endereço já existir).
function slugPreview(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'projeto';
}

async function newProject() {
  const sel = h('select', {}, h('option', { value: 'empty' }, 'Projeto vazio'), h('option', { value: 'demo' }, 'Projeto de exemplo (simulador)'));
  const r = await askName({ title: 'Novo projeto', extra: { el: h('label', { class: 'field' }, 'Começar com', sel), get value() { return sel.value; } } });
  if (!r) return;
  try {
    const { slug } = await api('api/projects', { method: 'POST', body: { name: r.name, template: r.extra } });
    toast(`Projeto criado em /${slug}/`, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function duplicateProject(p) {
  const r = await askName({ title: `Duplicar "${p.name}"`, value: `${p.name} (cópia)`, ok: 'Duplicar' });
  if (!r) return;
  try {
    const { slug } = await api('api/projects', { method: 'POST', body: { name: r.name, from: p.slug } });
    toast(`Cópia criada em /${slug}/. Confira os IPs dos PLCs antes de usar.`, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function renameProject(p) {
  const r = await askName({ title: 'Renomear projeto', value: p.name, ok: 'Renomear' });
  if (!r) return;
  try {
    await api(`api/projects/${p.slug}/name`, { method: 'PUT', body: { name: r.name } });
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteProject(p) {
  if (!(await confirmBox(`Excluir o projeto "${p.name}" (/${p.slug}/)? A comunicação com os PLCs dele para. A pasta vai para data/lixeira e pode ser recuperada.`))) return;
  try {
    await api(`api/projects/${p.slug}`, { method: 'DELETE' });
    toast('Projeto excluído', 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function showVersions(p) {
  let list;
  try { list = await api(`api/projects/${p.slug}/versions`); } catch (e) { return toast(e.message, 'err'); }
  openModal(h('div', { style: { width: '520px', maxWidth: '100%' } },
    h('h3', {}, `Versões salvas — ${p.name}`),
    h('p', { class: 'hint' }, 'A cada "Salvar", a versão anterior é guardada (as últimas 30). Restaurar também guarda a versão atual antes.'),
    list.length
      ? h('div', { class: 'table-wrap', style: { maxHeight: '55vh', overflow: 'auto' } }, h('table', { class: 'grid versions' },
        h('thead', {}, h('tr', {}, ['Salva em', 'Tamanho', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, list.map((v) => h('tr', {},
          h('td', {}, fmtDate(v.ts)), h('td', {}, `${(v.size / 1024).toFixed(0)} KB`),
          h('td', {}, h('button', { class: 'btn small', onclick: async () => {
            if (!(await confirmBox(`Voltar "${p.name}" para a versão de ${fmtDate(v.ts)}?`))) return;
            try { await api(`api/projects/${p.slug}/versions/${v.file}/restore`, { method: 'POST' }); toast('Versão restaurada', 'ok'); } catch (e) { toast(e.message, 'err'); }
          } }, 'Restaurar')))))))
      : h('p', { class: 'hint' }, 'Nenhuma versão anterior ainda.'),
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Fechar'))));
}

function pickFile(handler) {
  const input = $('fileImport');
  input.onchange = () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { handler(JSON.parse(r.result)); } catch { toast('Arquivo JSON inválido', 'err'); } };
    r.readAsText(f);
  };
  input.click();
}

// Aceita o backup de um projeto (ou o .json exportado pelo menu do próprio projeto).
async function importProject(data) {
  const project = data?.jbihm === 'projeto' ? data.project : data;
  if (!project || !Array.isArray(project.screens) || !Array.isArray(project.tags)) return toast('Arquivo não é um projeto da JB IHM', 'err');
  const r = await askName({ title: 'Importar projeto', value: project.name || 'Projeto importado', ok: 'Importar' });
  if (!r) return;
  try {
    const { slug } = await api('api/projects', { method: 'POST', body: { name: r.name, project } });
    toast(`Projeto importado em /${slug}/`, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function restoreAll(data) {
  if (data?.jbihm !== 'backup') return toast('Arquivo não é um backup geral da JB IHM', 'err');
  const names = data.projects.map((p) => p.project?.name || p.slug).join(', ');
  const choice = await new Promise((resolve) => {
    const done = (v) => { closeModal(); resolve(v); };
    openModal(h('div', { style: { maxWidth: '460px' } },
      h('h3', {}, 'Restaurar backup geral'),
      h('p', {}, `O arquivo tem ${data.projects.length} projeto(s): ${names}.`),
      h('p', { class: 'hint' }, 'Projetos que já existem com o mesmo endereço podem ser substituídos ou mantidos (nesse caso o backup vira uma cópia com outro endereço).'),
      h('div', { class: 'confirm-actions', style: { flexWrap: 'wrap' } },
        h('button', { class: 'btn', onclick: () => done(null) }, 'Cancelar'),
        h('button', { class: 'btn', onclick: () => done('copy') }, 'Manter atuais e criar cópias'),
        h('button', { class: 'btn danger', onclick: () => done('overwrite') }, 'Substituir existentes'))));
  });
  if (!choice) return;
  try {
    const r = await api('api/backup/restore', { method: 'POST', body: { ...data, overwrite: choice === 'overwrite' } });
    toast(`Restaurado. Novos: ${r.created.length}, substituídos: ${r.replaced.length}`, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

main().catch((e) => toast('Erro ao iniciar: ' + e.message, 'err'));
