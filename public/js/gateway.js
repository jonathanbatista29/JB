// Gateway: liga tags de conexões diferentes (ex.: multímetro -> PLC e PLC -> multímetro).
import { state, on, h, markDirty, uid, confirmBox, can, LV } from './state.js';

let root, statusCells = new Map(), srcCells = new Map();

export function initGateway(el) {
  root = el;
  el.classList.add('list-page');
  on('project', () => { if (root.classList.contains('active')) renderGateway(); });
  on('gateway', updateStatus);
  on('values', updateSources);
  on('status', updateSources);
}

const fmt = (v) => (v == null ? '---' : typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4).replace('.', ',') : String(v));

function srcValue(src) {
  const m = String(src || '').match(/^@status:(.+)$/);
  if (m) return state.status[m[1]]?.state === 'online' ? 1 : 0;
  return state.values[src]?.v;
}

function updateSources() {
  for (const [id, td] of srcCells) {
    const b = (state.project?.gateway || []).find((x) => x.id === id);
    if (b) td.textContent = fmt(srcValue(b.source));
  }
}

function updateStatus() {
  for (const [id, td] of statusCells) {
    const s = state.gateway.find((x) => x.id === id);
    if (!s) { td.replaceChildren(h('span', { class: 'hint' }, 'Salve para ativar')); continue; }
    td.replaceChildren(
      s.error
        ? h('span', { class: 'err-txt', title: s.error }, '✖ ', s.error)
        : s.ts ? h('span', { class: 'ok-txt' }, `✔ ${fmt(s.sent)} às ${new Date(s.ts).toLocaleTimeString('pt-BR')}`) : h('span', { class: 'hint' }, 'aguardando'),
      s.count ? h('small', { class: 'hint' }, ` (${s.count} envio${s.count > 1 ? 's' : ''})`) : '');
  }
}

export function renderGateway() {
  if (!state.project) return;
  const p = state.project;
  p.gateway ||= [];
  statusCells = new Map();
  srcCells = new Map();
  const eng = can(LV.ENG);
  const connName = (id) => p.connections.find((c) => c.id === id)?.name || '?';

  // Lista de tags agrupada por conexão (+ status das conexões como origem).
  const tagOptions = (value, { writable = false, withStatus = false } = {}) => [
    h('option', { value: '' }, '— escolha —'),
    ...p.connections.map((c) => h('optgroup', { label: c.name },
      withStatus ? h('option', { value: '@status:' + c.id, selected: value === '@status:' + c.id }, `● Status da conexão (1 = online)`) : '',
      p.tags.filter((t) => t.connection === c.id && (!writable || t.access !== 'R'))
        .map((t) => h('option', { value: t.name, selected: t.name === value }, `${t.name}${t.description ? ' — ' + t.description : ''}`)))),
  ];

  const row = (b) => {
    const set = (k, conv = (x) => x, rerender = false) => (e) => {
      b[k] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
      markDirty();
      if (rerender) renderGateway();
    };
    const srcTd = h('td', { class: 'val' }, fmt(srcValue(b.source)));
    srcCells.set(b.id, srcTd);
    const stTd = h('td', { class: 'gw-status' });
    statusCells.set(b.id, stTd);
    const pulse = b.mode === 'pulse';
    const srcTag = p.tags.find((t) => t.name === b.source);
    const dstTag = p.tags.find((t) => t.name === b.target);
    return h('tr', { class: b.enabled === false ? 'disabled-row' : '' },
      h('td', {}, h('input', { type: 'checkbox', checked: b.enabled !== false, onchange: set('enabled', Boolean, true) })),
      h('td', {}, h('input', { type: 'text', value: b.name, placeholder: 'ex.: Tensão para o PLC', onchange: set('name') })),
      h('td', {}, h('select', { onchange: set('source', String, true) }, tagOptions(b.source, { withStatus: true })),
        h('small', { class: 'hint' }, srcTag ? connName(srcTag.connection) : String(b.source).startsWith('@status:') ? 'status' : '')),
      srcTd,
      h('td', { class: 'gw-arrow' }, '➜'),
      h('td', {}, h('select', { onchange: set('target', String, true) }, tagOptions(b.target, { writable: true })),
        h('small', { class: 'hint' }, dstTag ? connName(dstTag.connection) : '')),
      h('td', {}, h('select', { onchange: set('mode', String, true) },
        h('option', { value: 'change', selected: !pulse }, 'Copiar sempre que mudar'),
        h('option', { value: 'pulse', selected: pulse }, 'Comando ao ligar (pulso)'))),
      pulse
        ? h('td', { class: 'gw-opts' },
          h('label', { class: 'field' }, 'Valor enviado', h('input', { type: 'text', value: b.value ?? '', placeholder: '1', onchange: set('value') })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(b.resetSource), onchange: set('resetSource', Boolean) }), 'Desligar origem depois'))
        : h('td', { class: 'gw-opts' },
          h('label', { class: 'field' }, 'Ganho', h('input', { type: 'number', step: 'any', value: b.gain ?? 1, onchange: set('gain', (v) => (v === '' ? 1 : Number(v))) })),
          h('label', { class: 'field' }, 'Offset', h('input', { type: 'number', step: 'any', value: b.offset ?? 0, onchange: set('offset', Number) }))),
      stTd,
      h('td', {}, h('button', { class: 'btn small danger eng-only', onclick: async () => {
        if (!(await confirmBox(`Excluir a ligação "${b.name || b.source + ' ➜ ' + b.target}"?`))) return;
        p.gateway = p.gateway.filter((x) => x !== b);
        markDirty();
        renderGateway();
      } }, '✕')));
  };

  const tbody = h('tbody', {}, p.gateway.map(row));
  if (!p.gateway.length) tbody.append(h('tr', {}, h('td', { colspan: 10, class: 'hint' }, 'Nenhuma ligação. Clique em "+ Nova ligação".')));

  const add = (preset = {}) => {
    p.gateway.push({ id: uid('gw'), name: '', enabled: true, source: '', target: '', mode: 'change', gain: 1, offset: 0, value: '', resetSource: false, ...preset });
    markDirty();
    renderGateway();
  };

  root.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, `Gateway (${p.gateway.length})`),
      h('button', { class: 'btn primary eng-only', onclick: () => add() }, '+ Nova ligação')),
    h('div', { class: 'note' },
      h('b', {}, 'Como funciona: '), 'cada ligação copia o valor de um tag (origem) para outro tag (destino), mesmo de equipamentos diferentes. ',
      h('br'), '• Multímetro ➜ PLC: origem "Medida" do multímetro, destino um REAL/INT no PLC (use ganho 1000 para mandar mV num INT).',
      h('br'), '• PLC ➜ multímetro: origem um INT do PLC com o nº da função, destino o tag de função do multímetro.',
      h('br'), '• Comando ao ligar: quando um bit do PLC liga, envia um comando (ex.: zerar/RST) e pode desligar o bit.',
      h('br'), '• "Status da conexão" manda 1/0 para o PLC saber se o multímetro está online.'),
    can(LV.ENG) ? '' : h('div', { class: 'note' }, 'Modo leitura: só Engenharia altera o gateway.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid gw-table' },
      h('thead', {}, h('tr', {}, ['Ativo', 'Nome', 'Origem', 'Agora', '', 'Destino', 'Modo', 'Opções', 'Situação', ''].map((c) => h('th', {}, c)))),
      tbody)),
    h('p', { class: 'hint' }, 'As ligações começam a funcionar depois de clicar em "Salvar".'));
  if (!eng) {
    root.querySelectorAll('input, select, button').forEach((el) => (el.disabled = true));
    root.querySelectorAll('.eng-only').forEach((el) => el.remove());
  }
  updateStatus();
}
