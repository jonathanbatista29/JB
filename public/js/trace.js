// Rastreabilidade: consulta dos registros (aba "🔎 Rastreabilidade") e configuração (⚙).
import { state, on, h, api, markDirty, uid, confirmBox, can, canEdit, isProduction, LV, toast, resizableTables } from './state.js';

const fmt = (v) => (v == null ? '—' : typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4).replace('.', ',') : String(v));
const fmtDate = (t) => new Date(t).toLocaleString('pt-BR');
const toLocalInput = (t) => new Date(t - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const resTxt = (r) => (r == null ? '' : r ? 'OK' : 'NOK');
const PAGE = 100;

// =================== CONSULTA ===================
let root, cardsEl, liveTimer;
const filt = { def: '', code: '', from: '', to: '', result: '', offset: 0 };

export function initTrace(el) {
  root = el;
  el.classList.add('list-page');
  on('trace', renderCards);
  // Registro novo: atualiza a lista se estiver na primeira página (sem esperar o operador pesquisar).
  on('traceRecord', () => {
    if (!root.classList.contains('active') || filt.offset) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(runSearch, 300);
  });
}

const defs = () => state.project?.trace?.defs || [];
const defName = (id) => defs().find((d) => d.id === id)?.name || id;

function renderCards() {
  if (!cardsEl) return;
  const list = defs();
  cardsEl.replaceChildren(...list.map((d) => {
    const s = state.trace.find((x) => x.id === d.id) || {};
    const res = s.lastResult == null ? '' : s.lastResult ? ' · OK' : ' · NOK';
    return h('div', { class: 'trace-card' + (s.error ? ' err' : '') + (d.enabled === false ? ' off' : '') },
      h('b', {}, d.name || '(sem nome)'),
      d.enabled === false ? h('div', { class: 'hint' }, 'Desativado')
        : s.error ? h('div', { class: 'err-txt' }, '✖ ', s.error, s.waiting ? ' — tentando de novo; o PLC não recebe a confirmação' : '')
          : s.lastTs ? h('div', { class: 'ok-txt' }, `✔ ${d.keyTag ? fmt(s.lastCode) : 'gravado'}${res} às ${new Date(s.lastTs).toLocaleTimeString('pt-BR')}`)
            : h('div', { class: 'hint' }, 'Aguardando o gatilho'),
      h('small', { class: 'hint' }, `${s.count || 0} registro(s) desde que a IHM iniciou`));
  }));
  if (!list.length) cardsEl.append(h('div', { class: 'note' }, 'Nenhum registro configurado.', can(LV.MAINT) ? ' Clique em "⚙ Configurar".' : ''));
}

export function renderTrace() {
  if (!state.project || !root) return;
  const defSel = h('select', { onchange: () => { filt.def = defSel.value; } },
    h('option', { value: '' }, 'Todos'), defs().map((d) => h('option', { value: d.id, selected: d.id === filt.def }, d.name || d.id)));
  const code = h('input', { type: 'text', value: filt.code, placeholder: 'ex.: 100245 (parte do código)', onkeydown: (e) => { if (e.key === 'Enter') go(); } });
  const from = h('input', { type: 'datetime-local', value: filt.from ? toLocalInput(filt.from) : '' });
  const to = h('input', { type: 'datetime-local', value: filt.to ? toLocalInput(filt.to) : '' });
  const result = h('select', {}, [['', 'Todos'], ['ok', 'Só OK'], ['nok', 'Só NOK']].map(([v, t]) => h('option', { value: v, selected: v === filt.result }, t)));
  const read = () => {
    filt.def = defSel.value; filt.code = code.value.trim(); filt.result = result.value;
    filt.from = from.value ? new Date(from.value).getTime() : ''; filt.to = to.value ? new Date(to.value).getTime() : '';
  };
  const go = () => { read(); filt.offset = 0; runSearch(); };
  const clear = () => { Object.assign(filt, { def: '', code: '', from: '', to: '', result: '', offset: 0 }); renderTrace(); };
  const exportCsv = () => { read(); location.href = 'api/trace.csv?' + qs(); };
  cardsEl = h('div', { class: 'trace-cards' });
  root.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, '🔎 Rastreabilidade'),
      can(LV.MAINT) ? h('button', { class: 'btn', onclick: () => document.querySelector('[data-page=tracecfg]')?.click() }, '⚙ Configurar') : ''),
    cardsEl,
    h('div', { class: 'trace-filters' },
      h('label', { class: 'field' }, 'Registro', defSel),
      h('label', { class: 'field' }, 'Código da peça', code),
      h('label', { class: 'field' }, 'De', from),
      h('label', { class: 'field' }, 'Até', to),
      h('label', { class: 'field' }, 'Resultado', result),
      h('div', { class: 'trace-btns' },
        h('button', { class: 'btn primary', onclick: go }, 'Pesquisar'),
        h('button', { class: 'btn', onclick: clear }, 'Limpar'),
        h('button', { class: 'btn', onclick: exportCsv, title: 'Arquivo CSV que abre no Excel (todas as linhas do filtro)' }, '⬇ Excel'))),
    h('div', { id: 'traceResult' }));
  renderCards();
  runSearch();
}

function qs(extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ def: filt.def, code: filt.code, from: filt.from, to: filt.to, result: filt.result, ...extra })) if (v !== '' && v != null) p.set(k, v);
  return p.toString();
}

async function runSearch() {
  const out = root.querySelector('#traceResult');
  if (!out) return;
  let r;
  try {
    r = await api('api/trace?' + qs({ limit: PAGE, offset: filt.offset }));
  } catch (e) {
    return out.replaceChildren(h('div', { class: 'err-txt' }, e.message));
  }
  // Colunas de dados: as da configuração e depois qualquer outra gravada nas linhas mostradas.
  const one = defs().find((d) => d.id === filt.def);
  const cols = [], label = new Map();
  for (const d of one ? [one] : defs()) for (const f of d.fields) if (!label.has(f.tag)) { cols.push(f.tag); label.set(f.tag, f.label || f.tag); }
  for (const row of r.rows) for (const k of Object.keys(row.data)) if (!label.has(k)) { cols.push(k); label.set(k, k); }
  const byCode = (c) => { filt.code = c; filt.offset = 0; renderTrace(); };
  const tbody = h('tbody', {}, r.rows.map((x) => h('tr', {},
    h('td', {}, fmtDate(x.ts)),
    h('td', {}, defName(x.def)),
    h('td', {}, x.code ? h('a', { href: '#', class: 'trace-code', title: 'Ver tudo desta peça', onclick: (e) => { e.preventDefault(); byCode(x.code); } }, x.code) : ''),
    h('td', { class: x.result == null ? '' : x.result ? 'ok-txt' : 'err-txt' }, resTxt(x.result)),
    h('td', {}, x.user || ''),
    cols.map((c) => h('td', { class: 'val' }, c in x.data ? fmt(x.data[c]) : '')))));
  if (!r.rows.length) tbody.append(h('tr', {}, h('td', { colspan: 5 + cols.length, class: 'hint' }, 'Nenhum registro encontrado.')));
  const last = Math.min(r.total, filt.offset + r.rows.length);
  const page = (d) => { filt.offset = Math.max(0, filt.offset + d); runSearch(); };
  out.replaceChildren(
    h('div', { class: 'trace-pager' },
      h('span', { class: 'hint' }, r.total ? `${(filt.offset + 1).toLocaleString('pt-BR')}–${last.toLocaleString('pt-BR')} de ${r.total.toLocaleString('pt-BR')} registro(s)` : '0 registros'),
      h('button', { class: 'btn small', disabled: !filt.offset, onclick: () => page(-PAGE) }, '◀ Anteriores'),
      h('button', { class: 'btn small', disabled: last >= r.total, onclick: () => page(PAGE) }, 'Próximos ▶')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Data/hora', 'Registro', 'Código', 'Resultado', 'Operador', ...cols.map((c) => label.get(c))].map((c) => h('th', {}, c)))),
      tbody)));
  resizableTables(out, 'trace-' + (filt.def || 'todos'));
}

// =================== CONFIGURAÇÃO ===================
let cfgRoot;

export function initTraceConfig(el) {
  cfgRoot = el;
  el.classList.add('list-page');
  on('project', () => { if (cfgRoot.classList.contains('active')) renderTraceConfig(); });
  on('trace', () => { if (cfgRoot.classList.contains('active')) updateCfgStatus(); });
}

const statusEls = new Map();
function updateCfgStatus() {
  for (const [id, el] of statusEls) {
    const s = state.trace.find((x) => x.id === id);
    el.replaceChildren(!s ? h('span', { class: 'hint' }, 'Salve para ativar')
      : s.error ? h('span', { class: 'err-txt' }, '✖ ', s.error)
        : s.lastTs ? h('span', { class: 'ok-txt' }, `✔ último às ${new Date(s.lastTs).toLocaleTimeString('pt-BR')} (${s.count} desde o início)`)
          : h('span', { class: 'hint' }, 'Funcionando, aguardando o gatilho'));
  }
}

export function renderTraceConfig() {
  if (!state.project || !cfgRoot) return;
  const p = state.project;
  p.trace ||= { keepDays: 0, defs: [] };
  p.trace.defs ||= [];
  statusEls.clear();
  const tagOpts = (value, filter = () => true, empty = '— nenhum —') => [h('option', { value: '' }, empty),
    ...p.connections.map((c) => h('optgroup', { label: c.name },
      p.tags.filter((t) => t.connection === c.id && filter(t)).map((t) => h('option', { value: t.name, selected: t.name === value }, `${t.name}${t.description ? ' — ' + t.description : ''}`))))];

  const card = (d) => {
    const set = (k, conv = (x) => x, rerender = false) => (e) => {
      d[k] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
      markDirty();
      if (rerender) renderTraceConfig();
    };
    const st = h('div', { class: 'trace-status' });
    statusEls.set(d.id, st);
    const fieldRows = d.fields.map((f, i) => h('tr', {},
      h('td', {}, f.tag, p.tags.some((t) => t.name === f.tag) ? '' : h('span', { class: 'err-txt' }, ' (tag não existe)')),
      h('td', {}, h('input', { type: 'text', value: f.label, placeholder: f.tag, onchange: (e) => { f.label = e.target.value; markDirty(); } })),
      h('td', {}, h('button', { class: 'btn small eng-only', title: 'Subir', disabled: !i, onclick: () => { d.fields.splice(i - 1, 0, d.fields.splice(i, 1)[0]); markDirty(); renderTraceConfig(); } }, '▲'),
        h('button', { class: 'btn small danger eng-only', onclick: () => { d.fields.splice(i, 1); markDirty(); renderTraceConfig(); } }, '✕'))));
    const addSel = h('select', { class: 'eng-only', onchange: () => {
      if (addSel.value && !d.fields.some((f) => f.tag === addSel.value)) d.fields.push({ tag: addSel.value, label: '' });
      markDirty();
      renderTraceConfig();
    } }, tagOpts('', (t) => !d.fields.some((f) => f.tag === t.name), '+ adicionar tag…'));
    const change = d.trigMode === 'change';
    return h('div', { class: 'trace-def' + (d.enabled === false ? ' off' : '') },
      h('div', { class: 'trace-def-head' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.enabled !== false, onchange: set('enabled', Boolean, true) }), 'Ativo'),
        h('input', { type: 'text', class: 'trace-name', value: d.name, placeholder: 'Nome (ex.: Teste final)', onchange: set('name') }),
        st,
        h('button', { class: 'btn small danger eng-only', onclick: async () => {
          if (!(await confirmBox(`Excluir o registro "${d.name || 'sem nome'}"? Os dados já gravados continuam no banco.`))) return;
          p.trace.defs = p.trace.defs.filter((x) => x !== d);
          markDirty();
          renderTraceConfig();
        } }, '✕ Excluir')),
      h('div', { class: 'prop-grid trace-grid' },
        h('label', { class: 'field' }, '1. Gatilho (quando gravar)', h('select', { onchange: set('trigger', String) }, tagOpts(d.trigger, (t) => change || t.type !== 'string', '— escolha —'))),
        h('label', { class: 'field' }, 'Grava quando', h('select', { onchange: set('trigMode', String, true) },
          h('option', { value: 'rising', selected: !change }, 'o bit liga (0 → 1)'),
          h('option', { value: 'change', selected: change }, 'o valor muda (código, passo…)'))),
        h('label', { class: 'field' }, '2. Código da peça (chave)', h('select', { onchange: set('keyTag', String) }, tagOpts(d.keyTag))),
        h('label', { class: 'field' }, '4. Resultado OK/NOK (opcional)', h('select', { onchange: set('resultTag', String, true) }, tagOpts(d.resultTag))),
        d.resultTag ? h('label', { class: 'field' }, 'Valor que significa OK', h('input', { type: 'number', value: d.okValue ?? '', placeholder: 'vazio = ligado / diferente de 0',
          onchange: set('okValue', (v) => (v === '' ? '' : Number(v))) })) : '',
        h('label', { class: 'field' }, '5. Confirmação ao PLC (bit)', h('select', { onchange: set('ackTag', String) }, tagOpts(d.ackTag, (t) => t.type === 'bool' && t.access !== 'R'))),
        change ? '' : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(d.resetTrigger), onchange: set('resetTrigger', Boolean) }),
          'IHM desliga o gatilho depois de gravar')),
      h('div', { class: 'field' }, '3. Dados gravados junto (nome da coluna opcional)'),
      h('table', { class: 'grid trace-fields' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'Nome da coluna'), h('th', {}, ''))),
        h('tbody', {}, fieldRows.length ? fieldRows : h('tr', {}, h('td', { colspan: 3, class: 'hint' }, 'Nenhum dado. Escolha os tags abaixo.')))),
      addSel);
  };

  const keep = h('input', { type: 'number', min: 0, value: p.trace.keepDays || 0, style: { width: '90px' },
    onchange: (e) => { p.trace.keepDays = Math.max(0, Math.round(Number(e.target.value) || 0)); markDirty(); } });
  cfgRoot.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, `Configurar rastreabilidade (${p.trace.defs.length})`),
      h('button', { class: 'btn small keep', onclick: () => document.querySelector('[data-page=trace]')?.click() }, '🔎 Ver registros'),
      h('button', { class: 'btn primary eng-only', onclick: () => {
        p.trace.defs.push({ id: uid('tr'), name: '', enabled: true, trigger: '', trigMode: 'rising', keyTag: '', fields: [], resultTag: '', okValue: '', ackTag: '', resetTrigger: false });
        markDirty();
        renderTraceConfig();
      } }, '+ Novo registro')),
    canEdit() ? '' : h('div', { class: 'note' }, isProduction() ? 'Projeto em produção: rastreabilidade funcionando, configuração travada.' : 'Modo leitura: só Engenharia altera a configuração.'),
    h('div', { class: 'note' },
      h('b', {}, 'Como funciona (handshake com o PLC): '),
      h('br'), '① O PLC escreve o código e os dados da peça e liga o bit de ', h('b', {}, 'gatilho'), '.',
      h('br'), '② A IHM grava uma linha no banco (data/hora, código, dados, resultado e operador logado) e liga o bit de ', h('b', {}, 'confirmação'), '.',
      h('br'), '③ O PLC vê a confirmação, libera a peça e desliga o gatilho. ④ A IHM desliga a confirmação.',
      h('br'), 'Se faltar leitura de algum tag, a IHM não grava, não confirma e tenta de novo a cada 2 s: no PLC, use um tempo limite para avisar "falha ao gravar".',
      h('br'), 'No modo "o valor muda" e com "IHM desliga o gatilho", a confirmação é um pulso de 1 s.'),
    h('div', {}, p.trace.defs.map(card)),
    !p.trace.defs.length ? h('p', { class: 'hint' }, 'Nenhum registro. Clique em "+ Novo registro".') : '',
    h('label', { class: 'field', style: { maxWidth: '360px' } }, 'Guardar os registros por (dias, 0 = sempre)', keep),
    h('p', { class: 'hint' }, 'Os registros ficam no banco do histórico do projeto e entram no backup. Clique em "Salvar" para aplicar.'));
  if (!canEdit()) {
    cfgRoot.querySelectorAll('input, select, button').forEach((el) => { if (!el.closest('.keep')) el.disabled = true; });
    cfgRoot.querySelectorAll('.eng-only').forEach((el) => el.remove());
  }
  updateCfgStatus();
}
