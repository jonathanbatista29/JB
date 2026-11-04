// Login, logout, troca de senha e logout automático por inatividade.
import { state, on, emit, h, api, loadMe, openModal, closeModal, toast, LV, LEVEL_NAMES } from './state.js';

let onChange = async () => {};
let idleTimer = null;
let lastActivity = Date.now();

export function initSession({ changed }) {
  onChange = changed;
  on('needLogin', ({ reason }) => showLogin({ reason }));
  on('sessionChanged', () => refresh());
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, () => (lastActivity = Date.now()), { passive: true });
  idleTimer = setInterval(checkIdle, 15000);
  document.addEventListener('click', () => document.querySelectorAll('.menu-list').forEach((m) => m.classList.add('hidden')));
}

async function refresh() {
  await loadMe().catch(() => {});
  await onChange();
}

function checkIdle() {
  const min = Number(state.me.idleMinutes);
  if (!state.me.user || !min) return;
  if (Date.now() - lastActivity > min * 60000) {
    logout(true);
  }
}

export async function logout(auto = false) {
  await api('api/logout', { method: 'POST' }).catch(() => {});
  if (auto) toast('Sessão encerrada por inatividade');
  await refresh();
}

// Formulário de login. Com `gate`, é a tela inicial obrigatória (não pode ser fechada).
export function showLogin({ reason = '', gate = false } = {}) {
  return new Promise((resolve) => {
    const user = h('input', { type: 'text', autocomplete: 'username', placeholder: 'Usuário', autocapitalize: 'none' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Senha' });
    const err = h('div', { class: 'form-err' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
    const form = h('form', { class: 'login-form', onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.textContent = '';
      try {
        await api('api/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
        closeModal();
        lastActivity = Date.now();
        await refresh();
        if (state.me.user?.mustChange) await forceChangePassword();
        resolve(true);
      } catch (ex) {
        err.textContent = ex.message;
        pass.value = '';
        pass.focus();
      } finally {
        btn.disabled = false;
      }
    } },
      h('div', { class: 'login-brand' }, 'JB', h('span', {}, 'IHM')),
      h('h3', {}, gate ? 'Acesso ao sistema' : 'Entrar'),
      reason ? h('div', { class: 'note' }, reason) : null,
      h('label', { class: 'field' }, 'Usuário', user),
      h('label', { class: 'field' }, 'Senha', pass),
      err,
      h('div', { class: 'confirm-actions' },
        gate ? null : h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); resolve(false); } }, 'Cancelar'),
        btn));
    openModal(form, { locked: gate });
    setTimeout(() => user.focus(), 50);
  });
}

// Troca de senha. Obrigatória no primeiro acesso ou após o administrador redefinir a senha.
export function changePassword({ forced = false } = {}) {
  return new Promise((resolve) => {
    const old = h('input', { type: 'password', autocomplete: 'current-password' });
    const n1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const err = h('div', { class: 'form-err' });
    const form = h('form', { class: 'login-form', onsubmit: async (e) => {
      e.preventDefault();
      if (n1.value !== n2.value) { err.textContent = 'As senhas novas não conferem'; return; }
      try {
        await api('api/me/password', { method: 'POST', body: { oldPassword: old.value, newPassword: n1.value } });
        // Trocar a senha encerra as outras sessões; esta continua válida.
        closeModal();
        toast('Senha alterada', 'ok');
        await refresh();
        resolve(true);
      } catch (ex) {
        err.textContent = ex.message;
      }
    } },
      h('h3', {}, forced ? 'Defina uma nova senha' : 'Trocar senha'),
      forced ? h('div', { class: 'note' }, 'Por segurança, troque a senha antes de continuar.') : null,
      h('label', { class: 'field' }, 'Senha atual', old),
      h('label', { class: 'field' }, 'Nova senha (mín. 4 caracteres)', n1),
      h('label', { class: 'field' }, 'Repita a nova senha', n2),
      err,
      h('div', { class: 'confirm-actions' },
        forced
          ? h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); logout(); resolve(false); } }, 'Sair')
          : h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); resolve(false); } }, 'Cancelar'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Salvar senha')));
    openModal(form, { locked: forced });
    setTimeout(() => old.focus(), 50);
  });
}

const forceChangePassword = () => changePassword({ forced: true });

// Botão do usuário na barra superior.
export function renderUserButton(el) {
  const u = state.me.user;
  if (!u) {
    el.replaceChildren(h('button', { class: 'btn', onclick: () => showLogin() }, '🔑 Entrar'));
    return;
  }
  const list = h('div', { class: 'menu-list hidden' },
    h('div', { class: 'menu-info' }, h('b', {}, u.name), h('small', {}, `${u.username} · ${LEVEL_NAMES[u.level]}`)),
    h('button', { onclick: () => changePassword() }, 'Trocar senha'),
    h('button', { onclick: () => logout() }, 'Sair'));
  const btn = h('button', { class: 'btn user-btn', title: `${u.name} — ${LEVEL_NAMES[u.level]}`, onclick: (e) => { e.stopPropagation(); list.classList.toggle('hidden'); } },
    '👤 ', h('span', { class: 'user-name' }, u.name), h('span', { class: 'lvl-badge lvl-' + u.level }, LEVEL_NAMES[u.level]));
  el.replaceChildren(h('div', { class: 'menu' }, btn, list));
}

export { forceChangePassword, LV, emit };
