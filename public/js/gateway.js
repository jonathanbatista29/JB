// Gateway: liga tags de conexões diferentes (ex.: multímetro -> PLC e PLC -> multímetro).
import { state, on, h, markDirty, uid, confirmBox, can, canEdit, isProduction, LV, openModal, closeModal, toast, resizableTables } from './state.js';

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
  const eng = canEdit();
  const connName = (id) => p.connections.find((c) => c.id === id)?.name || '?';

  // Lista de tags agrupada por conexão (+ status das conexões como origem).
  const tagOptions = (value, { writable = false, withStatus = false } = {}) => [
    h('option', { value: '' }, '— escolha —'),
    ...p.connections.map((c) => h('optgroup', { label: c.name },
      withStatus ? h('option', { value: '@status:' + c.id, selected: value === '@status:' + c.id }, `● Status da conexão (1 = online)`) : '',
      p.tags.filter((t) => t.connection === c.id && (!writable || t.access !== 'R'))
        .map((t) => h('option', { value: t.name, selected: t.name === value }, `${t.name}${t.description ? ' — ' + t.description : ''}`)))),
  ];

  // "Só quando <tag> = <valor>": cada função do multímetro pode ir para uma memória diferente.
  const condFields = (b, set) => h('div', { class: 'gw-cond' },
    h('label', { class: 'field' }, 'Só quando', h('select', { onchange: set('condTag', String, true) },
      h('option', { value: '' }, 'sempre'),
      p.tags.filter((t) => t.type !== 'string' && t.name !== b.source).map((t) => h('option', { value: t.name, selected: t.name === b.condTag }, t.name)))),
    b.condTag ? h('label', { class: 'field' }, '=', h('input', { type: 'number', value: b.condValue ?? '', onchange: set('condValue', (v) => (v === '' ? '' : Number(v))) })) : '');

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
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(b.resetSource), onchange: set('resetSource', Boolean) }), 'Desligar origem depois'),
          condFields(b, set))
        : h('td', { class: 'gw-opts' },
          h('label', { class: 'field' }, 'Ganho', h('input', { type: 'number', step: 'any', value: b.gain ?? 1, onchange: set('gain', (v) => (v === '' ? 1 : Number(v))) })),
          h('label', { class: 'field' }, 'Offset', h('input', { type: 'number', step: 'any', value: b.offset ?? 0, onchange: set('offset', Number) })),
          condFields(b, set)),
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
      h('button', { class: 'btn eng-only', onclick: () => functionWizard() }, '+ Medida por função'),
      h('button', { class: 'btn primary eng-only', onclick: () => add() }, '+ Nova ligação')),
    h('div', { class: 'note' },
      h('b', {}, 'Como funciona: '), 'cada ligação copia o valor de um tag (origem) para outro tag (destino), mesmo de equipamentos diferentes. ',
      h('br'), '• Multímetro ➜ PLC: origem "Medida" do multímetro, destino um REAL/INT no PLC (use ganho 1000 para mandar mV num INT).',
      h('br'), '• PLC ➜ multímetro: origem um INT do PLC com o nº da função, destino o tag de função do multímetro.',
      h('br'), '• Comando ao ligar: quando um bit do PLC liga, envia um comando (ex.: zerar/RST) e pode desligar o bit.',
      h('br'), '• "Status da conexão" manda 1/0 para o PLC saber se o multímetro está online.',
      h('br'), '• "Só quando": copia apenas quando outro tag tem um valor. Ex.: medida ➜ memória de tensão só quando a função = 1. ',
      'O botão "+ Medida por função" cria isso para todas as funções de uma vez.'),
    eng ? '' : h('div', { class: 'note' }, isProduction() ? 'Projeto em produção: gateway funcionando, configuração travada.' : 'Modo leitura: só Engenharia altera o gateway.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid gw-table' },
      h('thead', {}, h('tr', {}, ['Ativo', 'Nome', 'Origem', 'Agora', '', 'Destino', 'Modo', 'Opções', 'Situação', ''].map((c) => h('th', {}, c)))),
      tbody)),
    h('p', { class: 'hint' }, 'As ligações começam a funcionar depois de clicar em "Salvar".'));
  if (!eng) {
    root.querySelectorAll('input, select, button').forEach((el) => (el.disabled = true));
    root.querySelectorAll('.eng-only').forEach((el) => el.remove());
  }
  resizableTables(root, 'gateway');
  updateStatus();
}

// ---------- Assistente: cada função do multímetro numa memória do PLC ----------
const FUNC_NAMES = { 'VOLT:DC': 'Tensão DC', 'VOLT:AC': 'Tensão AC', 'CURR:DC': 'Corrente DC', 'CURR:AC': 'Corrente AC', RES: 'Resistência',
  FRES: 'Resistência 4 fios', FREQ: 'Frequência', CAP: 'Capacitância', PER: 'Período', CONT: 'Continuidade', DIOD: 'Diodo', TEMP: 'Temperatura' };

// Lê a tabela {1=VOLT:DC;2=...} do endereço do tag de função.
function functionTable(tag) {
  const m = String(tag?.address || '').match(/\{([^{}]*=[^{}]*)\}/);
  if (!m) return [];
  return m[1].split(';').map((x) => x.split('=')).filter((x) => x.length >= 2)
    .map(([k, ...v]) => ({ n: Number(k), code: v.join('=').trim() })).filter((x) => Number.isFinite(x.n));
}

function functionWizard() {
  const p = state.project;
  const scpiConns = new Set(p.connections.filter((c) => c.driver === 'scpi').map((c) => c.id));
  const funcTags = p.tags.filter((t) => scpiConns.has(t.connection) && functionTable(t).length);
  const readTags = p.tags.filter((t) => scpiConns.has(t.connection) && /READ\?|MEAS/i.test(t.address) && t.type !== 'string');
  if (!funcTags.length || !readTags.length) {
    return toast('Crie antes os tags do multímetro (aba PLCs → "+ Criar tags do multímetro")', 'err');
  }
  const targets = p.tags.filter((t) => !scpiConns.has(t.connection) && t.access !== 'R' && t.type !== 'string' && t.type !== 'bool');
  const srcSel = h('select', {}, readTags.map((t) => h('option', { value: t.name }, t.name)));
  const funcSel = h('select', { onchange: () => fillRows() }, funcTags.map((t) => h('option', { value: t.name }, t.name)));
  const rows = h('tbody');
  const picks = new Map();
  function fillRows() {
    picks.clear();
    const table = functionTable(p.tags.find((t) => t.name === funcSel.value));
    rows.replaceChildren(...table.map((f) => {
      const dst = h('select', {}, h('option', { value: '' }, '— não enviar —'),
        targets.map((t) => h('option', { value: t.name }, `${t.name} (${p.connections.find((c) => c.id === t.connection)?.name || '?'})`)));
      const gain = h('input', { type: 'number', step: 'any', value: 1, style: { width: '80px' } });
      picks.set(f.n, { f, dst, gain });
      return h('tr', {}, h('td', {}, String(f.n)), h('td', {}, FUNC_NAMES[f.code.toUpperCase()] || f.code), h('td', {}, dst), h('td', {}, gain));
    }));
  }
  fillRows();
  const create = () => {
    let n = 0;
    for (const { f, dst, gain } of picks.values()) {
      if (!dst.value) continue;
      p.gateway.push({ id: uid('gw'), name: `${FUNC_NAMES[f.code.toUpperCase()] || f.code} ➜ ${dst.value}`, enabled: true,
        source: srcSel.value, target: dst.value, mode: 'change', gain: Number(gain.value) || 1, offset: 0, value: '', resetSource: false,
        condTag: funcSel.value, condValue: f.n });
      n++;
    }
    if (!n) return toast('Escolha pelo menos uma memória do PLC', 'err');
    closeModal();
    markDirty();
    renderGateway();
    toast(`${n} ligação(ões) criadas. Clique em Salvar para ativar.`, 'ok');
  };
  openModal(h('div', { class: 'gw-wizard' },
    h('h3', {}, 'Medida por função ➜ memórias do PLC'),
    h('p', { class: 'hint' }, 'Para cada função, escolha a memória do PLC que recebe a medida. A medida só é copiada quando o multímetro está naquela função.'),
    !targets.length ? h('div', { class: 'note' }, 'Nenhum tag de escrita (INT/DINT/REAL) do PLC encontrado. Crie os tags do PLC na aba Tags primeiro.') : '',
    h('div', { class: 'prop-grid' }, h('label', { class: 'field' }, 'Tag da medida', srcSel), h('label', { class: 'field' }, 'Tag da função', funcSel)),
    h('div', { class: 'table-wrap', style: { maxHeight: '50vh', overflow: 'auto', marginTop: '10px' } },
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Nº', 'Função', 'Memória do PLC', 'Ganho'].map((c) => h('th', {}, c)))), rows)),
    h('div', { class: 'confirm-actions' },
      h('button', { class: 'btn', onclick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: create }, 'Criar ligações'))));
}
