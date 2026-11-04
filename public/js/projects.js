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
      admin ? h('button', { class: 'btn', onclick: () => pickFile(restoreAll) }, 'Restaurar backup geral') : '',
      admin ? h('button', { class: 'btn', onclick: autoBackupDialog }, '⏰ Backup automático') : '',
      admin ? h('button', { class: 'btn', onclick: httpsDialog }, '🔒 HTTPS') : ''),
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
    h('div', { class: 'card-head' }, h('h3', { style: { marginRight: 'auto' } }, p.name),
      h('span', { class: 'mode-badge ' + (p.mode === 'production' ? 'prod' : 'edit') }, p.mode === 'production' ? '● PRODUÇÃO' : '✎ EDIÇÃO')),
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
      eng ? (p.mode === 'production'
        ? h('button', { class: 'btn small', onclick: () => setMode(p, 'edit') }, '✎ Editar')
        : h('button', { class: 'btn small run-btn', onclick: () => setMode(p, 'production') }, '▶ Produção')) : '',
      eng ? h('button', { class: 'btn small', onclick: () => renameProject(p) }, 'Renomear') : '',
      eng ? h('button', { class: 'btn small', onclick: () => duplicateProject(p) }, 'Duplicar') : ''),
    eng ? h('div', { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => (location.href = `api/projects/${p.slug}/export`) }, '⬇ Backup do projeto'),
      h('button', { class: 'btn small', onclick: () => (location.href = `api/projects/${p.slug}/history-db`) }, '⬇ Histórico (.db)'),
      h('button', { class: 'btn small', onclick: () => restoreHistory(p) }, '⬆ Restaurar histórico (.db)'),
      h('button', { class: 'btn small', onclick: () => showVersions(p) }, '🕘 Versões salvas'),
      h('button', { class: 'btn small', onclick: () => pickFile((data) => restoreInto(p, data)) }, '⬆ Restaurar backup aqui'),
      admin ? h('button', { class: 'btn small danger', onclick: () => deleteProject(p) }, 'Excluir') : '') : '');
}

async function setMode(p, mode) {
  const msg = mode === 'production'
    ? `⚠ Colocar "${p.name}" em produção? A edição fica travada para todos e os painéis abertos vão para a tela inicial (${p.startScreen}). Para escolher outra tela inicial, abra o projeto.`
    : `Voltar "${p.name}" para o modo edição? A operação continua, mas o projeto poderá ser alterado.`;
  if (!(await confirmBox(msg))) return;
  try {
    await api(`api/projects/${p.slug}/mode`, { method: 'POST', body: { mode } });
    render();
  } catch (e) { toast(e.message, 'err'); }
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
    const { slug } = await api('api/projects', { method: 'POST', body: { name: r.name, project, images: data?.images } });
    toast(`Projeto importado em /${slug}/`, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

// Abre um backup (.json) por cima de um projeto existente. A versão atual fica em "Versões salvas".
async function restoreInto(p, data) {
  const project = data?.jbihm === 'projeto' ? data.project : data;
  if (!project || !Array.isArray(project.screens) || !Array.isArray(project.tags)) return toast('Arquivo não é um projeto da JB IHM', 'err');
  if (p.mode === 'production') return toast('Projeto em produção: volte para o modo edição antes de restaurar', 'err');
  const when = data?.exportedAt ? ` (backup de ${fmtDate(data.exportedAt)})` : '';
  if (!(await confirmBox(`Substituir "${p.name}" pelo backup "${project.name || '?'}"${when}? A configuração atual é guardada em "Versões salvas" e pode ser recuperada. O endereço /${p.slug}/ continua o mesmo.`))) return;
  try {
    // Primeiro as imagens do backup (mesmos nomes de arquivo), depois a configuração.
    for (const [file, img] of Object.entries(data?.images || {})) {
      await api(`${p.slug}/api/images`, { method: 'POST', body: { file, name: file, data: img } });
    }
    await api(`${p.slug}/api/project`, { method: 'PUT', body: { ...project, name: p.name } });
    toast('Backup restaurado', 'ok');
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

// ---------- Restaurar histórico (.db) ----------
function restoreHistory(p) {
  if (p.mode === 'production') return toast('Projeto em produção: volte para o modo edição antes de restaurar o histórico', 'err');
  const input = h('input', { type: 'file', accept: '.db,application/octet-stream', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    if (!(await confirmBox(`Substituir o histórico de "${p.name}" pelo arquivo "${f.name}" (${(f.size / 1048576).toFixed(1)} MB)? ` +
      'Tendências, eventos de alarme e dados gravados passam a ser os do arquivo. O histórico atual é guardado na pasta do projeto (historico_antes_...db).'))) return;
    toast('Enviando histórico...');
    try {
      const r = await fetch(`api/projects/${p.slug}/history-db`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      toast(`Histórico restaurado. O anterior foi guardado como ${j.kept || '-'}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  document.body.append(input);
  input.click();
}

// ---------- Backup automático diário ----------
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function autoBackupDialog() {
  let s;
  try { s = await api('api/auto-backup'); } catch (e) { return toast(e.message, 'err'); }
  const enabled = h('input', { type: 'checkbox', checked: s.enabled });
  const time = h('input', { type: 'time', value: s.time });
  const folder = h('input', { type: 'text', value: s.folder, placeholder: s.defaultFolder });
  const keep = h('input', { type: 'number', min: 1, max: 365, value: s.keep });
  const hist = h('input', { type: 'checkbox', checked: s.includeHistory });
  const save = async () => {
    try {
      await api('api/auto-backup', { method: 'PUT', body: { enabled: enabled.checked, time: time.value, folder: folder.value, keep: Number(keep.value), includeHistory: hist.checked } });
      toast('Backup automático salvo', 'ok');
      autoBackupDialog();
    } catch (e) { toast(e.message, 'err'); }
  };
  const runNow = async (btn) => {
    btn.disabled = true; btn.textContent = 'Fazendo backup...';
    try { const r = await api('api/auto-backup/run', { method: 'POST' }); toast(`Backup criado: ${r.name} (${fmtSize(r.size)})`, 'ok'); } catch (e) { toast(e.message, 'err'); }
    autoBackupDialog();
  };
  const restore = async (b) => {
    const choice = await new Promise((resolve) => {
      const done = (v) => { closeModal(); resolve(v); };
      const withHist = h('input', { type: 'checkbox', checked: b.history.length > 0, disabled: !b.history.length });
      openModal(h('div', { style: { maxWidth: '480px' } },
        h('h3', {}, `Restaurar ${b.name.replace('jbihm_', '').replace('_', ' ')}`),
        h('p', { class: 'hint' }, 'Projetos que já existem podem ser substituídos ou mantidos (o backup vira uma cópia com outro endereço).'),
        h('label', { class: 'check' }, withHist, `Restaurar também o histórico (${b.history.length ? b.history.join(', ') : 'não incluído neste backup'})`),
        h('div', { class: 'confirm-actions', style: { flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => done(null) }, 'Cancelar'),
          h('button', { class: 'btn', onclick: () => done({ overwrite: false, history: withHist.checked }) }, 'Manter atuais e criar cópias'),
          h('button', { class: 'btn danger', onclick: () => done({ overwrite: true, history: withHist.checked }) }, 'Substituir existentes'))));
    });
    if (!choice) return autoBackupDialog();
    try {
      const r = await api(`api/auto-backup/${b.name}/restore`, { method: 'POST', body: choice });
      toast(`Restaurado. Novos: ${r.created.length}, substituídos: ${r.replaced.length}${choice.history ? ', histórico: ' + (r.history.join(', ') || '-') : ''}`, 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
  const status = s.lastError
    ? h('div', { class: 'note warn' }, `❌ Último backup falhou (${fmtDate(s.lastRun)}): ${s.lastError}`)
    : s.lastRun ? h('div', { class: 'note' }, `✔ Último backup: ${fmtDate(s.lastRun)} — ${s.lastResult}`) : h('div', { class: 'note' }, 'Nenhum backup feito ainda.');
  const runBtn = h('button', { class: 'btn', onclick: () => runNow(runBtn) }, '▶ Fazer backup agora');
  openModal(h('div', { class: 'mode-dialog', style: { width: '620px' } },
    h('h3', {}, '⏰ Backup automático diário'),
    h('p', { class: 'hint', style: { margin: 0 } }, 'Uma vez por dia salva todos os projetos (configuração e imagens), o histórico e os usuários numa pasta. Se o computador estiver desligado no horário, o backup é feito assim que o servidor ligar.'),
    status,
    h('label', { class: 'check' }, enabled, 'Ligado'),
    h('div', { class: 'prop-grid' },
      h('label', { class: 'field' }, 'Horário', time),
      h('label', { class: 'field' }, 'Quantidade de cópias guardadas', keep),
      h('label', { class: 'field full' }, 'Pasta (vazio = padrão). Ex.: D:\\Backups\\IHM ou uma pasta de rede', folder),
      h('label', { class: 'check full' }, hist, 'Incluir o histórico (.db) de cada projeto')),
    h('div', { class: 'hint' }, `Pasta usada: ${s.folderPath}`, s.nextRun ? ` · próximo backup: ${fmtDate(s.nextRun)}` : ''),
    h('div', { class: 'confirm-actions', style: { justifyContent: 'space-between' } }, runBtn, h('button', { class: 'btn primary', onclick: save }, 'Salvar configuração')),
    h('h4', { style: { margin: '6px 0 0' } }, `Backups guardados (${s.backups.length})`),
    s.backups.length
      ? h('div', { class: 'table-wrap', style: { maxHeight: '30vh', overflow: 'auto' } }, h('table', { class: 'grid versions' },
        h('thead', {}, h('tr', {}, ['Data', 'Tamanho', 'Histórico', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, s.backups.map((b) => h('tr', {},
          h('td', {}, fmtDate(b.ts)), h('td', {}, fmtSize(b.size)), h('td', {}, b.history.length ? '✔' : '—'),
          h('td', {}, h('button', { class: 'btn small', onclick: () => restore(b) }, 'Restaurar')))))))
      : h('p', { class: 'hint' }, 'Nenhum backup na pasta ainda.'),
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Fechar'))));
}

// ---------- HTTPS ----------
async function httpsDialog() {
  let s;
  try { s = await api('api/https'); } catch (e) { return toast(e.message, 'err'); }
  const enabled = h('input', { type: 'checkbox', checked: s.enabled });
  const port = h('input', { type: 'number', min: 1, max: 65535, value: s.port });
  const redirect = h('input', { type: 'checkbox', checked: s.redirect });
  const hosts = h('input', { type: 'text', placeholder: 'ex.: ihm.minhaempresa.com.br, 200.150.10.20' });
  const c = s.cert;
  const host = location.hostname;
  const httpsUrl = `https://${host}:${s.port}/`;
  const save = async () => {
    try {
      const r = await api('api/https', { method: 'PUT', body: { enabled: enabled.checked, port: Number(port.value), redirect: redirect.checked } });
      toast(r.enabled ? `HTTPS ligado em https://${host}:${r.port}/` : 'HTTPS desligado', 'ok');
      httpsDialog();
    } catch (e) { toast(e.message, 'err'); }
  };
  const generate = async () => {
    if (c && !(await confirmBox('Gerar um certificado novo? Os aparelhos que já confiaram no certificado atual vão precisar confiar de novo.'))) return httpsDialog();
    try {
      await api('api/https/generate', { method: 'POST', body: { hosts: hosts.value.split(',').map((x) => x.trim()).filter(Boolean) } });
      toast('Certificado gerado', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    httpsDialog();
  };
  const custom = () => {
    const cert = h('textarea', { rows: 5, placeholder: '-----BEGIN CERTIFICATE-----' });
    const key = h('textarea', { rows: 5, placeholder: '-----BEGIN PRIVATE KEY-----' });
    openModal(h('div', { class: 'mode-dialog', style: { width: '560px' } },
      h('h3', {}, 'Usar certificado próprio'),
      h('p', { class: 'hint', style: { margin: 0 } }, 'Cole o certificado e a chave privada em formato PEM (ex.: certificado da empresa ou Let\'s Encrypt). A chave não pode ter senha.'),
      h('label', { class: 'field' }, 'Certificado (pode incluir a cadeia)', cert),
      h('label', { class: 'field' }, 'Chave privada', key),
      h('div', { class: 'confirm-actions' },
        h('button', { class: 'btn', onclick: httpsDialog }, 'Voltar'),
        h('button', { class: 'btn primary', onclick: async () => {
          try { await api('api/https/cert', { method: 'POST', body: { cert: cert.value, key: key.value } }); toast('Certificado instalado', 'ok'); httpsDialog(); } catch (e) { toast(e.message, 'err'); }
        } }, 'Instalar'))));
  };
  openModal(h('div', { class: 'mode-dialog', style: { width: '620px' } },
    h('h3', {}, '🔒 HTTPS (acesso seguro)'),
    h('p', { class: 'hint', style: { margin: 0 } }, 'Criptografa a comunicação entre os navegadores e a IHM. Recomendado para acesso fora da rede local, de preferência junto com uma VPN.'),
    s.running ? h('div', { class: 'note' }, '✔ HTTPS ativo: ', h('b', {}, httpsUrl)) : s.error ? h('div', { class: 'note warn' }, '❌ ', s.error) : h('div', { class: 'note' }, 'HTTPS desligado.'),
    c ? h('div', { class: 'hint' },
      h('div', {}, `Certificado: ${c.selfSigned ? 'autoassinado' : c.issuer}`),
      h('div', {}, `Nomes: ${c.altNames}`),
      h('div', { class: c.expired ? 'prio-alta' : '' }, `Válido até: ${new Date(c.validTo).toLocaleDateString('pt-BR')}${c.expired ? ' — VENCIDO' : ''}`),
      h('div', { style: { wordBreak: 'break-all' } }, `Impressão digital: ${c.fingerprint}`))
      : h('div', { class: 'note warn' }, 'Ainda não há certificado. Gere um certificado ou instale o seu.'),
    h('div', { class: 'prop-grid' },
      h('label', { class: 'check full' }, enabled, 'Ligar HTTPS'),
      h('label', { class: 'field' }, 'Porta HTTPS', port),
      h('label', { class: 'check', style: { alignSelf: 'end' } }, redirect, 'Redirecionar HTTP para HTTPS')),
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn primary', onclick: save }, 'Salvar')),
    h('h4', { style: { margin: '6px 0 0' } }, 'Certificado'),
    h('label', { class: 'field' }, 'Nomes ou IPs extras (para acesso de fora: domínio ou IP público)', hosts),
    h('div', { class: 'confirm-actions', style: { justifyContent: 'flex-start', flexWrap: 'wrap' } },
      h('button', { class: 'btn', onclick: generate }, c ? '↻ Gerar novo certificado' : '+ Gerar certificado autoassinado'),
      h('button', { class: 'btn', onclick: custom }, 'Usar certificado próprio'),
      c ? h('a', { class: 'btn', href: 'api/https/cert.crt' }, '⬇ Baixar certificado (instalar nos aparelhos)') : ''),
    h('p', { class: 'hint', style: { margin: 0 } }, 'Com certificado autoassinado o navegador mostra um aviso na primeira vez. Para tirar o aviso, instale o certificado baixado em cada aparelho como "autoridade confiável".',
      ' Para acessar de fora, libere a porta HTTPS no roteador/firewall ou use uma VPN, e use senhas fortes.'),
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Fechar'))));
}

main().catch((e) => toast('Erro ao iniciar: ' + e.message, 'err'));
