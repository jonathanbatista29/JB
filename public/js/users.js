// Página de usuários (somente administrador): cadastro, configurações de acesso e registro de ações.
import { state, h, api, toast, confirmBox, LV, LEVEL_NAMES, resizableTables } from './state.js';

let root;

export function initUsers(el) {
  root = el;
  el.classList.add('list-page');
}

const levelOptions = (sel) => state.me.levels.map((l) => h('option', { value: l.level, selected: l.level === sel }, l.name));

export async function renderUsers() {
  if (state.me.level < LV.ADMIN) return root.replaceChildren();
  let users, settings, audit;
  try {
    [users, settings, audit] = await Promise.all([api('api/users'), api('api/settings'), api('api/audit')]);
  } catch (e) {
    return root.replaceChildren(h('p', { class: 'hint' }, e.message));
  }
  const me = state.me.user.username;
  const run = async (fn, okMsg) => {
    try { await fn(); if (okMsg) toast(okMsg, 'ok'); } catch (e) { toast(e.message, 'err'); }
    renderUsers();
  };

  const row = (u) => h('tr', { class: u.enabled ? '' : 'disabled-row' },
    h('td', {}, h('b', {}, u.username), u.username === me ? h('small', { class: 'hint' }, ' (você)') : ''),
    h('td', {}, h('input', { type: 'text', value: u.name, onchange: (e) => run(() => api(`api/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { name: e.target.value } })) })),
    h('td', {}, h('select', { onchange: (e) => run(() => api(`api/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { level: Number(e.target.value) } }), 'Nível alterado') }, levelOptions(u.level))),
    h('td', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: u.enabled, disabled: u.username === me,
      onchange: (e) => run(() => api(`api/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { enabled: e.target.checked } })) }), u.enabled ? 'Ativo' : 'Inativo')),
    h('td', {}, u.mustChange ? h('span', { class: 'prio-media' }, 'Deve trocar a senha') : 'OK'),
    h('td', { style: { whiteSpace: 'nowrap' } },
      h('button', { class: 'btn small', onclick: () => resetPassword(u, run) }, 'Redefinir senha'), ' ',
      u.username === me ? null : h('button', { class: 'btn small danger', onclick: async () => {
        if (await confirmBox(`Excluir o usuário "${u.username}"?`)) run(() => api(`api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }), 'Usuário excluído');
      } }, '✕')));

  // Novo usuário
  const nu = { username: h('input', { type: 'text', placeholder: 'ex.: joao.silva', autocapitalize: 'none' }), name: h('input', { type: 'text', placeholder: 'Nome completo' }),
    level: h('select', {}, levelOptions(LV.OPERATOR)), password: h('input', { type: 'password', placeholder: 'Senha inicial', autocomplete: 'new-password' }) };
  const addForm = h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    run(() => api('api/users', { method: 'POST', body: { username: nu.username.value, name: nu.name.value, level: Number(nu.level.value), password: nu.password.value } }), 'Usuário criado');
  } },
    h('h3', { class: 'section-title', style: { margin: 0 } }, 'Novo usuário'),
    h('div', { class: 'prop-grid' },
      h('label', { class: 'field' }, 'Usuário', nu.username), h('label', { class: 'field' }, 'Nome', nu.name),
      h('label', { class: 'field' }, 'Nível', nu.level), h('label', { class: 'field' }, 'Senha inicial', nu.password)),
    h('p', { class: 'hint', style: { margin: 0 } }, 'O usuário vai trocar a senha no primeiro login.'),
    h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, '+ Criar usuário')));

  // Configurações de acesso
  const guest = h('select', {}, [[-1, 'Bloqueado (login obrigatório)'], [0, 'Somente visualizar as telas'], [1, 'Operar sem login (Operador)']]
    .map(([v, t]) => h('option', { value: v, selected: v === settings.guestLevel }, t)));
  const idle = h('input', { type: 'number', min: 0, max: 1440, value: settings.idleMinutes });
  const settingsForm = h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    run(() => api('api/settings', { method: 'PUT', body: { guestLevel: Number(guest.value), idleMinutes: Number(idle.value) } }), 'Configurações salvas');
  } },
    h('h3', { class: 'section-title', style: { margin: 0 } }, 'Configurações de acesso'),
    h('label', { class: 'field' }, 'Acesso sem login', guest),
    h('label', { class: 'field' }, 'Sair automaticamente após (minutos sem uso, 0 = nunca)', idle),
    h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Salvar configurações')));

  root.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, `Usuários (${users.length})`)),
    h('div', { class: 'note' },
      h('b', {}, 'Níveis: '),
      'Operador — opera as telas e reconhece alarmes · ',
      'Manutenção — também vê Tags/PLCs e escreve valores de teste · ',
      'Engenharia — edita telas, tags, PLCs, alarmes e salva o projeto · ',
      'Administrador — também gerencia usuários.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Usuário', 'Nome', 'Nível', 'Situação', 'Senha', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, users.map(row)))),
    h('div', { class: 'cards' }, addForm, settingsForm),
    h('h2', { class: 'section-title' }, 'Registro de ações'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Data/hora', 'Usuário', 'Ação', 'Detalhe'].map((c) => h('th', {}, c)))),
      h('tbody', {}, audit.map((e) => h('tr', {},
        h('td', { style: { whiteSpace: 'nowrap' } }, new Date(e.ts).toLocaleString('pt-BR')), h('td', {}, e.user), h('td', {}, e.action), h('td', {}, e.detail)))))));
  resizableTables(root, 'usuarios');
}

async function resetPassword(u, run) {
  const pass = prompt(`Nova senha para ${u.username} (mín. 4 caracteres). Ele vai trocar no próximo login:`);
  if (!pass) return;
  run(() => api(`api/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { password: pass } }), 'Senha redefinida');
}
