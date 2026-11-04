// Páginas de configuração: Tags, Conexões (PLCs) e Alarmes.
import { state, on, h, markDirty, uid, confirmBox, toast, writeTag, keypad, ackAlarm } from './state.js';

const TYPES = [['bool', 'BOOL (bit)'], ['int16', 'INT (16 bits)'], ['uint16', 'WORD / UINT (16 bits)'], ['int32', 'DINT (32 bits)'], ['uint32', 'DWORD / UDINT (32 bits)'], ['float32', 'REAL (float 32)'], ['string', 'STRING']];

const ADDRESS_HELP = {
  simulator: 'Simulador: sine:amplitude:período:offset · ramp:max:período · random:min:max · square:período · ou qualquer nome (memória).',
  s7: 'Siemens S7: DB1,X0.0 (bit) · DB1,INT2 · DB1,DINT4 · DB1,REAL8 · M0.0 · MW10 · MD20 · MR30 (real) · I0.0 · Q0.1 · IW64 · QW64',
  'modbus-tcp': 'Modbus (base 0): C0 coil · DI0 entrada digital · HR0 holding register · IR0 input register · HR0.3 bit 3 do registrador. Também aceita 00001/10001/30001/40001.',
  'modbus-rtu': 'Modbus (base 0): C0 coil · DI0 entrada digital · HR0 holding register · IR0 input register · HR0.3 bit 3 do registrador. Também aceita 00001/10001/30001/40001.',
};

const fmtVal = (v) => (v == null ? '---' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4).replace('.', ',') : String(v));
const STATUS_TXT = { online: 'Online', error: 'Erro', connecting: 'Conectando…', disabled: 'Desativado' };

// =================== TAGS ===================
let tagsRoot, tagCells = new Map(), tagFilter = '', tagConnFilter = '';

export function initTags(el) {
  tagsRoot = el;
  el.classList.add('list-page');
  on('project', renderTags);
  on('values', (changed) => {
    for (const [name, val] of Object.entries(changed)) {
      const td = tagCells.get(name);
      if (td) { td.textContent = fmtVal(val.v); td.className = 'val' + (val.q === 'bad' ? ' bad-q' : ''); td.title = val.err || ''; }
    }
  });
}

export function renderTags() {
  if (!state.project) return;
  const p = state.project;
  tagCells = new Map();
  const connName = (id) => p.connections.find((c) => c.id === id);
  const usedDrivers = [...new Set(p.connections.map((c) => c.driver))];

  const filterIn = h('input', { type: 'text', placeholder: 'Filtrar tags…', value: tagFilter, style: { maxWidth: '220px' },
    oninput: (e) => { tagFilter = e.target.value; renderRows(); } });
  const connSel = h('select', { style: { maxWidth: '200px' }, onchange: (e) => { tagConnFilter = e.target.value; renderRows(); } },
    h('option', { value: '' }, 'Todas as conexões'), p.connections.map((c) => h('option', { value: c.id, selected: c.id === tagConnFilter }, c.name)));
  const tbody = h('tbody');

  function renameRefs(oldName, newName) {
    for (const s of p.screens) for (const w of s.widgets) {
      const pr = w.props || {};
      if (pr.tag === oldName) pr.tag = newName;
      if (pr.faultTag === oldName) pr.faultTag = newName;
      if (pr.tags) pr.tags = pr.tags.split(',').map((t) => (t.trim() === oldName ? newName : t.trim())).join(', ');
    }
    for (const a of p.alarms) if (a.tag === oldName) a.tag = newName;
  }

  function row(t) {
    const set = (k) => (e) => { t[k] = e.target.value; markDirty(); if (k === 'connection') renderRows(); };
    const nameIn = h('input', { type: 'text', value: t.name, onchange: (e) => {
      const nv = e.target.value.trim().replace(/\s+/g, '_');
      if (!nv || p.tags.some((x) => x !== t && x.name === nv)) { toast('Nome vazio ou já existe', 'err'); e.target.value = t.name; return; }
      renameRefs(t.name, nv);
      t.name = nv;
      e.target.value = nv;
      markDirty();
    } });
    const valTd = h('td', { class: 'val' }, fmtVal(state.values[t.name]?.v));
    tagCells.set(t.name, valTd);
    const conn = connName(t.connection);
    return h('tr', {},
      h('td', {}, nameIn),
      h('td', {}, h('select', { onchange: set('connection') },
        p.connections.map((c) => h('option', { value: c.id, selected: c.id === t.connection }, c.name)),
        !conn ? h('option', { value: t.connection, selected: true }, '(sem conexão)') : null)),
      h('td', {}, h('input', { type: 'text', value: t.address, placeholder: conn?.driver === 's7' ? 'DB1,REAL0' : conn?.driver === 'simulator' ? 'memoria1' : 'HR0', onchange: set('address') })),
      h('td', {}, h('select', { onchange: set('type') }, TYPES.map(([v, txt]) => h('option', { value: v, selected: v === t.type }, txt)))),
      h('td', {}, h('select', { onchange: set('access') }, h('option', { value: 'RW', selected: t.access !== 'R' }, 'Leitura/Escrita'), h('option', { value: 'R', selected: t.access === 'R' }, 'Somente leitura'))),
      h('td', {}, h('input', { type: 'text', value: t.description || '', onchange: set('description') })),
      valTd,
      h('td', { style: { whiteSpace: 'nowrap' } },
        t.access !== 'R' ? h('button', { class: 'btn small', title: 'Escrever valor', onclick: () => testWrite(t) }, '✎') : null, ' ',
        h('button', { class: 'btn small danger', title: 'Excluir', onclick: async () => {
          if (!(await confirmBox(`Excluir o tag "${t.name}"?`))) return;
          p.tags = p.tags.filter((x) => x !== t);
          markDirty();
          renderTags();
        } }, '✕')));
  }

  function renderRows() {
    const f = tagFilter.toLowerCase();
    const list = p.tags.filter((t) => (!tagConnFilter || t.connection === tagConnFilter) &&
      (!f || t.name.toLowerCase().includes(f) || (t.description || '').toLowerCase().includes(f) || String(t.address).toLowerCase().includes(f)));
    tbody.replaceChildren(...list.map(row));
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: 8, class: 'hint' }, 'Nenhum tag. Clique em "+ Novo tag".')));
  }

  const addTag = () => {
    if (!p.connections.length) return toast('Cadastre um PLC primeiro (aba PLCs)', 'err');
    let i = p.tags.length + 1;
    while (p.tags.some((t) => t.name === 'Tag' + i)) i++;
    const connection = tagConnFilter || p.connections[0].id;
    p.tags.push({ name: 'Tag' + i, connection, address: '', type: 'int16', access: 'RW', description: '' });
    markDirty();
    tagFilter = '';
    renderTags();
    tagsRoot.scrollTop = tagsRoot.scrollHeight;
  };

  renderRows();
  tagsRoot.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, `Tags (${p.tags.length})`), filterIn, connSel, h('button', { class: 'btn primary', onclick: addTag }, '+ Novo tag')),
    ...usedDrivers.map((d) => h('div', { class: 'note' }, ADDRESS_HELP[d] || '')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Nome', 'Conexão', 'Endereço', 'Tipo', 'Acesso', 'Descrição', 'Valor', ''].map((c) => h('th', {}, c)))),
      tbody)),
    h('p', { class: 'hint' }, 'Tags novos ou alterados começam a ser lidos depois de clicar em "Salvar".'));
}

async function testWrite(t) {
  if (t.type === 'bool') {
    const cur = state.values[t.name]?.v;
    return writeTag(t.name, !cur).catch(() => {});
  }
  if (t.type === 'string') {
    const v = prompt(`Valor para ${t.name}`, state.values[t.name]?.v ?? '');
    if (v != null) writeTag(t.name, v).catch(() => {});
    return;
  }
  const v = await keypad({ title: t.name, value: state.values[t.name]?.v, decimals: t.type === 'float32' ? 4 : 0 });
  if (v != null) writeTag(t.name, v).catch(() => {});
}

// =================== CONEXÕES / PLCs ===================
let connRoot, statusEls = new Map();

export function initConnections(el) {
  connRoot = el;
  el.classList.add('list-page');
  on('project', renderConnections);
  on('status', updateConnStatus);
}

function updateConnStatus() {
  for (const [id, el] of statusEls) {
    const st = state.status[id];
    el.replaceChildren(
      h('span', { class: 'dot ' + (st?.state || '') }),
      h('span', {}, st ? STATUS_TXT[st.state] || st.state : 'Não salvo / aguardando'),
      st?.error ? h('span', { class: 'err' }, '— ' + st.error) : '');
  }
}

export function renderConnections() {
  if (!state.project) return;
  const p = state.project;
  statusEls = new Map();

  const card = (c) => {
    const model = state.models.find((m) => m.id === c.model);
    const set = (k, conv = (x) => x) => (e) => { c[k] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value); markDirty(); };
    const numF = (k, label, ph) => h('label', { class: 'field' }, label, h('input', { type: 'number', value: c[k] ?? '', placeholder: ph, onchange: set(k, (v) => (v === '' ? '' : Number(v))) }));
    const txtF = (k, label, ph) => h('label', { class: 'field' }, label, h('input', { type: 'text', value: c[k] ?? '', placeholder: ph, onchange: set(k) }));

    const vendors = [...new Set(state.models.map((m) => m.vendor))];
    const modelSel = h('select', { onchange: (e) => {
      const m = state.models.find((x) => x.id === e.target.value);
      c.model = m.id;
      c.driver = m.driver;
      Object.assign(c, m.defaults);
      markDirty();
      renderConnections();
    } }, vendors.map((v) => h('optgroup', { label: v }, state.models.filter((m) => m.vendor === v).map((m) => h('option', { value: m.id, selected: m.id === c.model }, m.name)))));

    const fields = [];
    if (c.driver === 's7') fields.push(txtF('host', 'IP do PLC', '192.168.0.1'), numF('port', 'Porta', '102'), numF('rack', 'Rack', '0'), numF('slot', 'Slot', '1'), numF('timeout', 'Timeout (ms)', '3000'));
    if (c.driver === 'modbus-tcp') fields.push(txtF('host', 'IP do PLC', '192.168.0.1'), numF('port', 'Porta', '502'), numF('unitId', 'Unit ID / Escravo', '1'), numF('timeout', 'Timeout (ms)', '2000'));
    if (c.driver === 'modbus-rtu') {
      fields.push(txtF('serialPort', 'Porta serial', '/dev/ttyUSB0 ou COM3'),
        h('label', { class: 'field' }, 'Baud rate', h('select', { onchange: set('baudRate', Number) }, [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => h('option', { value: b, selected: Number(c.baudRate) === b }, b)))),
        h('label', { class: 'field' }, 'Paridade', h('select', { onchange: set('parity') }, [['none', 'Nenhuma'], ['even', 'Par'], ['odd', 'Ímpar']].map(([v, t]) => h('option', { value: v, selected: c.parity === v }, t)))),
        numF('dataBits', 'Data bits', '8'), numF('stopBits', 'Stop bits', '1'), numF('unitId', 'Endereço do escravo', '1'), numF('timeout', 'Timeout (ms)', '2000'));
    }
    if (c.driver === 'modbus-tcp' || c.driver === 'modbus-rtu') fields.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(c.wordSwap), onchange: set('wordSwap') }), 'Inverter words (32 bits CDAB)'));

    const status = h('div', { class: 'status-line' });
    statusEls.set(c.id, status);
    const nTags = p.tags.filter((t) => t.connection === c.id).length;

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('input', { type: 'text', value: c.name, onchange: set('name') }),
        h('label', { class: 'check', title: 'Ativar / desativar comunicação' }, h('input', { type: 'checkbox', checked: c.enabled !== false, onchange: set('enabled') }), 'Ativo')),
      status,
      h('label', { class: 'field' }, 'Modelo do PLC', modelSel),
      model?.notes ? h('div', { class: 'note' }, model.notes) : null,
      h('div', { class: 'prop-grid' }, ...fields, numF('pollMs', 'Ciclo de leitura (ms)', '500')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { class: 'hint', style: { marginRight: 'auto' } }, `${nTags} tag(s)`),
        h('button', { class: 'btn small danger', onclick: async () => {
          if (!(await confirmBox(nTags ? `"${c.name}" tem ${nTags} tag(s). Excluir a conexão mesmo assim? (os tags ficam sem conexão)` : `Excluir "${c.name}"?`))) return;
          p.connections = p.connections.filter((x) => x !== c);
          markDirty();
          renderConnections();
        } }, 'Excluir')));
  };

  const add = () => {
    const m = state.models.find((x) => x.id === 's7-1200');
    p.connections.push({ id: uid('plc'), name: `PLC ${p.connections.length + 1}`, model: m.id, driver: m.driver, host: '', ...m.defaults, pollMs: 500, enabled: true });
    markDirty();
    renderConnections();
  };

  connRoot.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, 'PLCs / Conexões'), h('button', { class: 'btn primary', onclick: add }, '+ Novo PLC')),
    h('p', { class: 'hint' }, 'Escolha o modelo, preencha o IP e clique em "Salvar" no topo para conectar. O status atualiza em tempo real.'),
    h('div', { class: 'cards' }, p.connections.map(card)));
  updateConnStatus();
}

// =================== ALARMES ===================
let alarmRoot;

export function initAlarms(el) {
  alarmRoot = el;
  el.classList.add('list-page');
  on('project', renderAlarms);
  on('alarms', renderAlarmLists);
}

let activeBody, histBody;

export function renderAlarms() {
  if (!state.project) return;
  const p = state.project;
  activeBody = h('tbody');
  histBody = h('tbody');
  const cfgBody = h('tbody');

  const row = (a) => {
    const set = (k, conv = (x) => x) => (e) => { a[k] = conv(e.target.value); markDirty(); };
    return h('tr', {},
      h('td', {}, h('select', { onchange: set('tag') }, h('option', { value: '' }, '—'), p.tags.map((t) => h('option', { value: t.name, selected: t.name === a.tag }, t.name)))),
      h('td', {}, h('select', { onchange: set('condition') }, [['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['==', '='], ['!=', '≠'], ['true', 'Ligado (1)'], ['false', 'Desligado (0)']]
        .map(([v, t]) => h('option', { value: v, selected: v === a.condition }, t)))),
      h('td', {}, h('input', { type: 'number', value: a.limit ?? '', style: { width: '90px' }, onchange: set('limit', Number) })),
      h('td', {}, h('input', { type: 'text', value: a.message, onchange: set('message') })),
      h('td', {}, h('select', { onchange: set('priority') }, [['alta', 'Alta'], ['media', 'Média'], ['baixa', 'Baixa']].map(([v, t]) => h('option', { value: v, selected: v === a.priority }, t)))),
      h('td', {}, h('button', { class: 'btn small danger', onclick: () => { p.alarms = p.alarms.filter((x) => x !== a); markDirty(); renderAlarms(); } }, '✕')));
  };
  cfgBody.append(...p.alarms.map(row));

  alarmRoot.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, 'Alarmes ativos'), h('button', { class: 'btn', onclick: () => ackAlarm('*') }, 'Reconhecer todos')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Desde', 'Prioridade', 'Mensagem', 'Tag', 'Valor', 'Estado', ''].map((c) => h('th', {}, c)))), activeBody)),
    h('div', { class: 'head' }, h('h2', { class: 'section-title' }, 'Configuração de alarmes'),
      h('button', { class: 'btn primary', onclick: () => { p.alarms.push({ id: uid('al'), tag: p.tags[0]?.name || '', condition: '>', limit: 0, message: 'Novo alarme', priority: 'media' }); markDirty(); renderAlarms(); } }, '+ Novo alarme')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Tag', 'Condição', 'Limite', 'Mensagem', 'Prioridade', ''].map((c) => h('th', {}, c)))), cfgBody)),
    h('h2', { class: 'section-title' }, 'Histórico de eventos'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Data/hora', 'Evento', 'Prioridade', 'Mensagem', 'Valor'].map((c) => h('th', {}, c)))), histBody)));
  renderAlarmLists();
}

function renderAlarmLists() {
  if (!activeBody) return;
  const { active = [], history = [] } = state.alarms;
  const dt = (t) => new Date(t).toLocaleString('pt-BR');
  activeBody.replaceChildren(...active.map((a) => h('tr', { class: a.acked ? '' : 'unacked' },
    h('td', {}, dt(a.since)), h('td', { class: 'prio-' + a.priority }, a.priority.toUpperCase()), h('td', {}, a.message), h('td', {}, a.tag),
    h('td', { class: 'val' }, fmtVal(a.value)), h('td', {}, a.cleared ? 'Normalizado' : 'Ativo', a.acked ? ' · reconhecido' : ''),
    h('td', {}, a.acked ? null : h('button', { class: 'btn small', onclick: () => ackAlarm(a.id) }, 'Reconhecer')))));
  if (!active.length) activeBody.append(h('tr', {}, h('td', { colspan: 7, class: 'hint' }, 'Nenhum alarme ativo ✔')));
  histBody.replaceChildren(...history.map((e) => h('tr', {},
    h('td', {}, dt(e.ts)), h('td', {}, e.event), h('td', { class: 'prio-' + e.priority }, e.priority), h('td', {}, e.message), h('td', {}, fmtVal(e.value)))));
}
