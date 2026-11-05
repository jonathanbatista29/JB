// Páginas de configuração: Tags, Conexões (PLCs) e Alarmes.
import { state, on, h, api, markDirty, uid, confirmBox, toast, writeTag, keypad, ackAlarm, can, canEdit, isProduction, LV, LEVEL_NAMES, resizableTables, collapsible, openModal, closeModal } from './state.js';

// Abaixo de Engenharia as páginas de configuração ficam só para leitura.
// Elementos com a classe "keep" (filtros, escrita de teste, reconhecer) continuam ativos.
function readOnly(root) {
  if (canEdit()) return;
  root.querySelectorAll('input, select, textarea, button').forEach((el) => { if (!el.closest('.keep')) el.disabled = true; });
  root.querySelectorAll('.eng-only').forEach((el) => el.remove());
}

const TYPES = [['bool', 'BOOL (bit)'], ['int16', 'INT (16 bits)'], ['uint16', 'WORD / UINT (16 bits)'], ['int32', 'DINT (32 bits)'], ['uint32', 'DWORD / UDINT (32 bits)'], ['float32', 'REAL (float 32)'], ['string', 'STRING']];

const ADDRESS_HELP = {
  simulator: 'Simulador: sine:amplitude:período:offset · ramp:max:período · random:min:max · square:período · ou qualquer nome (memória).',
  s7: 'Siemens S7: DB1,X0.0 (bit) · DB1,INT2 · DB1,DINT4 · DB1,REAL8 · M0.0 · MW10 · MD20 · MR30 (real) · I0.0 · Q0.1 · IW64 · QW64',
  scpi: 'Multímetro / SCPI: comando de consulta · READ? (medida atual) · MEAS:VOLT:DC? · *IDN? (STRING) · leitura e escrita: FUNC? | CONF:{1=VOLT:DC;2=VOLT:AC} · só comando: | *RST (BOOL, envia ao ligar).',
  logix: 'CompactLogix / ControlLogix: nome do tag no Studio 5000 · Motor_Run · Program:MainProgram.Nivel · Receita[3] · Maquina.Velocidade · Status.5 (bit de DINT). Tipos: BOOL, INT, DINT, REAL, STRING.',
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

  const filterIn = h('input', { type: 'text', class: 'keep', placeholder: 'Filtrar tags…', value: tagFilter, style: { maxWidth: '220px' },
    oninput: (e) => { tagFilter = e.target.value; renderRows(); } });
  const connSel = h('select', { class: 'keep', style: { maxWidth: '200px' }, onchange: (e) => { tagConnFilter = e.target.value; renderRows(); } },
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
    for (const s of p.screens) if (s.openTag === oldName) s.openTag = newName;
    const nav = p.navigation || {};
    for (const k of ['requestTag', 'currentTag']) if (nav[k] === oldName) nav[k] = newName;
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
      h('td', {}, h('input', { type: 'text', value: t.address, placeholder: conn?.driver === 's7' ? 'DB1,REAL0' : conn?.driver === 'logix' ? 'Motor_Run' : conn?.driver === 'scpi' ? 'READ?' : conn?.driver === 'simulator' ? 'memoria1' : 'HR0', onchange: set('address') })),
      h('td', {}, h('select', { onchange: set('type') }, TYPES.map(([v, txt]) => h('option', { value: v, selected: v === t.type }, txt)))),
      h('td', {}, h('select', { onchange: set('access') }, h('option', { value: 'RW', selected: t.access !== 'R' }, 'Leitura/Escrita'), h('option', { value: 'R', selected: t.access === 'R' }, 'Somente leitura'))),
      h('td', {}, h('select', { title: 'Nível mínimo para escrever neste tag', onchange: (e) => { t.writeLevel = Number(e.target.value); markDirty(); } },
        [1, 2, 3, 4].map((l) => h('option', { value: l, selected: (Number(t.writeLevel) || 1) === l }, LEVEL_NAMES[l])))),
      h('td', {}, h('input', { type: 'text', value: t.description || '', onchange: set('description') })),
      h('td', { class: 'log-cell', title: 'Registrar no banco de histórico. Banda: variação mínima para gravar. Seg.: gravar no máximo 1 vez a cada X segundos.' },
        t.type === 'string' ? '—' : [
          h('input', { type: 'checkbox', checked: Boolean(t.log), onchange: (e) => { t.log = e.target.checked; markDirty(); } }),
          t.type === 'bool' ? null : h('input', { type: 'number', min: 0, step: 'any', placeholder: 'banda', title: 'Banda morta: só grava se variar mais que isto', value: t.logDeadband ?? '', style: { width: '64px' },
            onchange: (e) => { t.logDeadband = e.target.value === '' ? '' : Math.abs(Number(e.target.value)); markDirty(); } }),
          h('input', { type: 'number', min: 0, step: 1, placeholder: 'seg.', title: 'Intervalo mínimo: grava no máximo 1 vez a cada X segundos (vazio = toda mudança)', value: t.logMinSec || '', style: { width: '58px' },
            onchange: (e) => { t.logMinSec = e.target.value === '' ? '' : Math.max(0, Math.round(Number(e.target.value))); markDirty(); } })]),
      valTd,
      h('td', { style: { whiteSpace: 'nowrap' } },
        t.access !== 'R' ? h('span', { class: 'keep' }, h('button', { class: 'btn small', title: 'Escrever valor', onclick: () => testWrite(t) }, '✎')) : null, ' ',
        h('button', { class: 'btn small danger eng-only', title: 'Excluir', onclick: async () => {
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
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: 10, class: 'hint' }, 'Nenhum tag.')));
    readOnly(tbody);
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
    h('div', { class: 'head' }, h('h2', {}, `Tags (${p.tags.length})`), filterIn, connSel,
      p.connections.some((c) => c.driver === 'logix') ? h('button', { class: 'btn eng-only', onclick: () => importFromPlc(), title: 'Escolher tags da lista do CompactLogix/ControlLogix' }, '⬇ Importar do PLC') : '',
      h('button', { class: 'btn primary eng-only', onclick: addTag }, '+ Novo tag')),
    canEdit() ? '' : h('div', { class: 'note' }, isProduction()
      ? 'Projeto em produção: configuração travada. Volte para o modo edição para alterar os tags.'
      : 'Modo leitura: só Engenharia altera tags. Você pode ver os valores e escrever valores de teste (✎).'),
    ...usedDrivers.map((d) => h('div', { class: 'note' }, ADDRESS_HELP[d] || '')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Nome', 'Conexão', 'Endereço', 'Tipo', 'Acesso', 'Escrita mín.', 'Descrição', 'Histórico', 'Valor', ''].map((c) => h('th', {}, c)))),
      tbody)),
    h('p', { class: 'hint' }, 'Tags novos ou alterados começam a ser lidos depois de clicar em "Salvar".'));
  readOnly(tagsRoot);
  resizableTables(tagsRoot, 'tags');
}

// ---------- Importar tags do PLC (CompactLogix / ControlLogix) ----------
const TYPE_LABEL = Object.fromEntries(TYPES);
// Bits que dá para endereçar dentro de um inteiro (ex.: explorar.0 ... explorar.31).
const BIT_MAX = { SINT: 7, USINT: 7, INT: 15, UINT: 15, DINT: 31, UDINT: 31 };

// "0-7, 10, 12-15" -> [0..7, 10, 12..15]; "*" ou "todos" -> todos os bits. Lança erro se inválido.
export function parseBits(text, max) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return [];
  if (t === '*' || t === 'todos' || t === 'tudo') return Array.from({ length: max + 1 }, (_, i) => i);
  const out = new Set();
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`"${part}" não é um bit válido`);
    const a = Number(m[1]), b = m[2] != null ? Number(m[2]) : a;
    if (a > b || b > max) throw new Error(`Bits vão de 0 a ${max}`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
async function importFromPlc() {
  const p = state.project;
  const conns = p.connections.filter((c) => c.driver === 'logix');
  const connSel = h('select', {}, conns.map((c) => h('option', { value: c.id, selected: c.id === tagConnFilter }, c.name)));
  const search = h('input', { type: 'text', placeholder: 'Buscar (ex.: motor, teste_ihm, Program:)…' });
  const onlyNew = h('input', { type: 'checkbox', checked: true });
  const tbody = h('tbody');
  const info = h('div', { class: 'hint' }, 'Carregando a lista de tags do PLC…');
  const btnOk = h('button', { class: 'btn primary', disabled: true }, 'Criar tags');
  const picked = new Map(); // endereço -> item (cria o tag do inteiro/real/etc.)
  const bitSel = new Map(); // endereço -> { item, text, bits } (cria um BOOL para cada bit)
  let list = [];
  const existing = () => new Set(p.tags.filter((t) => t.connection === connSel.value).map((t) => String(t.address).toLowerCase()));
  const nameFor = (addr) => {
    let base = addr.replace(/^Program:[^.]+\./, '').replace(/\[(\d+)\]/g, '_$1').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'Tag';
    let n = base, i = 2;
    while (p.tags.some((t) => t.name === n)) n = `${base}_${i++}`;
    return n;
  };
  function draw() {
    const q = search.value.trim().toLowerCase();
    const have = existing();
    const rows = list.filter((x) => (!q || x.address.toLowerCase().includes(q) || x.plcType.toLowerCase().includes(q)) && (!onlyNew.checked || !have.has(x.address.toLowerCase())));
    const shown = rows.slice(0, 500);
    tbody.replaceChildren(...shown.map((x) => {
      const ok = Boolean(x.type);
      const cb = h('input', { type: 'checkbox', checked: picked.has(x.address), disabled: !ok,
        onchange: (e) => { e.target.checked ? picked.set(x.address, x) : picked.delete(x.address); upd(); } });
      const max = BIT_MAX[x.plcType];
      let bitsTd = h('td', {});
      if (max != null) {
        const inp = h('input', { type: 'text', class: 'bits-in', placeholder: `ex.: 0-${Math.min(7, max)}`, value: bitSel.get(x.address)?.text || '',
          title: `Bits de 0 a ${max}. Exemplos: 0-7 · 0,1,5 · * (todos)` });
        inp.addEventListener('input', () => {
          try {
            const bits = parseBits(inp.value, max);
            inp.classList.remove('bad');
            inp.title = bits.length ? `Cria ${bits.length} tag(s) BOOL: ${x.address}.${bits[0]}${bits.length > 1 ? ' … ' + x.address + '.' + bits.at(-1) : ''}` : `Bits de 0 a ${max}`;
            bits.length ? bitSel.set(x.address, { item: x, text: inp.value, bits }) : bitSel.delete(x.address);
          } catch (e) {
            inp.classList.add('bad');
            inp.title = e.message;
            bitSel.delete(x.address);
          }
          upd();
        });
        bitsTd = h('td', {}, inp);
      }
      return h('tr', { class: ok ? '' : 'disabled-row', title: ok ? '' : 'Tipo não suportado pela IHM' },
        h('td', {}, cb), h('td', {}, x.address), h('td', {}, x.plcType), h('td', {}, ok ? TYPE_LABEL[x.type] : '—'), bitsTd,
        h('td', {}, have.has(x.address.toLowerCase()) ? '✔ já existe' : ''));
    }));
    info.textContent = `${list.length} tag(s) no PLC · ${rows.length} na busca${rows.length > shown.length ? ` (mostrando ${shown.length}; refine a busca)` : ''}`;
    selAll.checked = shown.length > 0 && shown.filter((x) => x.type).every((x) => picked.has(x.address));
    selAll.onchange = () => { for (const x of shown) if (x.type) selAll.checked ? picked.set(x.address, x) : picked.delete(x.address); draw(); upd(); };
  }
  const selAll = h('input', { type: 'checkbox', title: 'Marcar todos os mostrados' });
  // Total a criar: tags marcados + um BOOL por bit (sem repetir os que já existem).
  const toCreate = () => {
    const have = existing();
    const out = [];
    for (const x of picked.values()) if (!have.has(x.address.toLowerCase())) out.push({ address: x.address, type: x.type, desc: x.program ? `${x.plcType} (programa ${x.program})` : x.plcType });
    for (const { item, bits } of bitSel.values()) {
      for (const b of bits) {
        const address = `${item.address}.${b}`;
        if (!have.has(address.toLowerCase())) out.push({ address, type: 'bool', desc: `bit ${b} de ${item.address} (${item.plcType})` });
      }
    }
    return out;
  };
  const upd = () => { const n = toCreate().length; btnOk.disabled = !n; btnOk.textContent = n ? `Criar ${n} tag(s)` : 'Criar tags'; };
  async function load() {
    picked.clear(); bitSel.clear(); upd();
    info.textContent = 'Carregando a lista de tags do PLC…';
    tbody.replaceChildren();
    try {
      list = await api(`api/connections/${encodeURIComponent(connSel.value)}/browse`);
      draw();
    } catch (e) {
      list = [];
      info.replaceChildren(h('span', { class: 'err-txt' }, e.message));
    }
  }
  search.addEventListener('input', draw);
  onlyNew.addEventListener('change', draw);
  connSel.addEventListener('change', load);
  btnOk.addEventListener('click', () => {
    const items = toCreate();
    for (const x of items) {
      p.tags.push({ name: nameFor(x.address), connection: connSel.value, address: x.address, type: x.type, access: 'RW', description: x.desc });
    }
    const n = items.length;
    markDirty();
    closeModal();
    tagConnFilter = connSel.value;
    renderTags();
    toast(`${n} tag(s) criados. Confira "Acesso" (leitura/escrita) e clique em Salvar.`, 'ok');
  });
  openModal(h('div', { class: 'import-dialog' },
    h('h3', {}, '⬇ Importar tags do PLC'),
    h('p', { class: 'hint', style: { margin: 0 } }, 'Lista lida do CompactLogix/ControlLogix ao conectar (opção "Ler lista de tags do PLC ao conectar" ligada e conexão salva). Marque os tags e clique em Criar. Para usar bits de um DINT/INT/SINT como BOOL, digite os bits na coluna "Bits" (ex.: 0-7, 0,1,5 ou * para todos). Para arrays, troque o [0] pelo elemento desejado depois.'),
    h('div', { class: 'prop-grid' }, h('label', { class: 'field' }, 'PLC', connSel), h('label', { class: 'field' }, 'Buscar', search)),
    h('label', { class: 'check' }, onlyNew, 'Esconder os que já existem na IHM'),
    info,
    h('div', { class: 'table-wrap', style: { maxHeight: '50vh', overflow: 'auto' } }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, selAll), ...['Endereço no PLC', 'Tipo no PLC', 'Tipo na IHM', 'Bits (BOOL)', ''].map((c) => h('th', {}, c)))), tbody)),
    h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancelar'), btnOk)));
  load();
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
    if (c.driver === 's7') fields.push(txtF('host', 'IP do PLC', 'ex.: 192.168.0.1'), numF('port', 'Porta', '102'), numF('rack', 'Rack', '0'), numF('slot', 'Slot', '1'), numF('timeout', 'Timeout (ms)', '3000'));
    if (c.driver === 'scpi') fields.push(txtF('host', 'IP do instrumento', 'ex.: 192.168.1.50'), numF('port', 'Porta', '5025'), numF('timeout', 'Timeout (ms)', '3000'));
    if (c.driver === 'logix') fields.push(txtF('host', 'IP do PLC', 'ex.: 192.168.1.10'), numF('slot', 'Slot da CPU', '0'), numF('timeout', 'Timeout (ms)', '10000'),
      h('label', { class: 'check full', title: 'Necessário para ler UDTs e STRING. Desmarque se o controlador não responder à conexão.' },
        h('input', { type: 'checkbox', checked: c.setup !== false, onchange: set('setup') }), 'Ler lista de tags do PLC ao conectar (UDT/STRING)'));
    if (c.driver === 'modbus-tcp') fields.push(txtF('host', 'IP do PLC', 'ex.: 192.168.0.1'), numF('port', 'Porta', '502'), numF('unitId', 'Unit ID / Escravo', '1'), numF('timeout', 'Timeout (ms)', '2000'));
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
      c.driver === 'scpi' ? h('button', { class: 'btn small eng-only', onclick: () => createDmmTags(c) }, '+ Criar tags do multímetro') : '',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { class: 'hint', style: { marginRight: 'auto' } }, `${nTags} tag(s)`),
        h('button', { class: 'btn small danger eng-only', onclick: async () => {
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
    h('div', { class: 'head' }, h('h2', {}, 'PLCs / Conexões'), h('button', { class: 'btn primary eng-only', onclick: add }, '+ Novo PLC')),
    canEdit() ? '' : h('div', { class: 'note' }, isProduction()
      ? 'Projeto em produção: configuração travada. Volte para o modo edição para alterar as conexões.'
      : 'Modo leitura: só Engenharia altera as conexões.'),
    h('p', { class: 'hint' }, 'Escolha o modelo, preencha o IP e clique em "Salvar" no topo para conectar. O status atualiza em tempo real.'),
    h('div', { class: 'cards' }, p.connections.map(card)));
  readOnly(connRoot);
  updateConnStatus();
}

// Tags prontos para um multímetro SCPI (medida, função por número, reset e identificação).
function createDmmTags(c) {
  const p = state.project;
  const base = c.name.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'DMM';
  const list = [
    { suffix: 'Medida', address: 'READ?', type: 'float32', access: 'R', description: 'Medida atual do multímetro' },
    { suffix: 'Funcao', address: 'FUNC? | CONF:{1=VOLT:DC;2=VOLT:AC;3=CURR:DC;4=CURR:AC;5=RES;6=FREQ;7=CAP;8=FRES;9=PER;10=CONT;11=DIOD;12=TEMP}', type: 'int16', access: 'RW',
      description: '1=VDC 2=VAC 3=IDC 4=IAC 5=Ohm 6=Freq 7=Cap 8=Ohm4fios 9=Período 10=Contin. 11=Diodo 12=Temp' },
    { suffix: 'Reset', address: '| *RST', type: 'bool', access: 'RW', description: 'Liga = envia *RST' },
    { suffix: 'IDN', address: '*IDN?', type: 'string', access: 'R', description: 'Identificação do instrumento' },
  ];
  let n = 0;
  for (const t of list) {
    const name = `${base}_${t.suffix}`;
    if (p.tags.some((x) => x.name === name)) continue;
    p.tags.push({ name, connection: c.id, address: t.address, type: t.type, access: t.access, description: t.description });
    n++;
  }
  markDirty();
  toast(n ? `${n} tag(s) criados. Confira os comandos no manual do instrumento e clique em Salvar.` : 'Os tags já existem', n ? 'ok' : '');
  renderConnections();
}

// =================== ALARMES ===================
// Duas abas: "Alarmes" (operação: ativos e últimos eventos) e "Config. Alarmes" (cadastro).
let alarmRoot, alarmCfgRoot;

export function initAlarms(el) {
  alarmRoot = el;
  el.classList.add('list-page');
  on('project', renderAlarms);
  on('alarms', renderAlarmLists);
}

export function initAlarmConfig(el) {
  alarmCfgRoot = el;
  el.classList.add('list-page');
  on('project', () => { if (alarmCfgRoot.classList.contains('active')) renderAlarmConfig(); });
}

let activeBody, histBody, activeCount;
const tableOf = (key, cols, body) => h('div', { class: 'table-wrap' }, h('table', { class: 'grid', 'data-key': key }, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), body));
const RESIZE_HINT = 'Clique no título para minimizar ou expandir · arraste a divisória do cabeçalho para mudar a largura da coluna (duplo clique volta ao automático).';

export function renderAlarms() {
  if (!state.project) return;
  activeBody = h('tbody');
  histBody = h('tbody');
  activeCount = h('span', { class: 'sec-count' });
  alarmRoot.replaceChildren(
    collapsible('alarmes-ativos', h('span', {}, 'Alarmes ativos ', activeCount),
      h('span', { class: 'keep', style: { display: 'flex', gap: '6px' } },
        h('button', { class: 'btn', onclick: () => ackAlarm('*') }, 'Reconhecer todos'),
        can(LV.MAINT) ? h('button', { class: 'btn', onclick: () => document.querySelector('[data-page=alarmcfg]')?.click() }, '⚙ Configurar alarmes') : ''),
      tableOf('ativos', ['Desde', 'Prioridade', 'Mensagem', 'Tag', 'Valor', 'Estado', ''], activeBody)),
    collapsible('alarmes-eventos', 'Últimos eventos',
      h('button', { class: 'btn small keep', onclick: () => document.querySelector('[data-page=history]').click() }, 'Ver histórico completo →'),
      tableOf('eventos', ['Data/hora', 'Evento', 'Prioridade', 'Mensagem', 'Valor', 'Usuário'], histBody)),
    h('p', { class: 'hint' }, RESIZE_HINT));
  resizableTables(alarmRoot, 'alarmes');
  renderAlarmLists();
}

export function renderAlarmConfig() {
  if (!state.project || !alarmCfgRoot) return;
  const p = state.project;
  const cfgBody = h('tbody');
  const row = (a) => {
    const set = (k, conv = (x) => x) => (e) => { a[k] = conv(e.target.value); markDirty(); };
    return h('tr', {},
      h('td', {}, h('select', { onchange: set('tag') }, h('option', { value: '' }, '—'), p.tags.map((t) => h('option', { value: t.name, selected: t.name === a.tag }, t.name)))),
      h('td', {}, h('select', { onchange: set('condition') }, [['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['==', '='], ['!=', '≠'], ['true', 'Ligado (1)'], ['false', 'Desligado (0)']]
        .map(([v, t]) => h('option', { value: v, selected: v === a.condition }, t)))),
      h('td', {}, h('input', { type: 'number', value: a.limit ?? '', onchange: set('limit', Number) })),
      h('td', {}, h('input', { type: 'text', value: a.message, onchange: set('message') })),
      h('td', {}, h('select', { onchange: set('priority') }, [['alta', 'Alta'], ['media', 'Média'], ['baixa', 'Baixa']].map(([v, t]) => h('option', { value: v, selected: v === a.priority }, t)))),
      h('td', {}, h('button', { class: 'btn small danger eng-only', onclick: () => { p.alarms = p.alarms.filter((x) => x !== a); markDirty(); renderAlarmConfig(); } }, '✕')));
  };
  cfgBody.append(...p.alarms.map(row));
  if (!p.alarms.length) cfgBody.append(h('tr', {}, h('td', { colspan: 6, class: 'hint' }, 'Nenhum alarme. Clique em "+ Novo alarme".')));
  alarmCfgRoot.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, `Configuração de alarmes (${p.alarms.length})`),
      h('button', { class: 'btn small keep', onclick: () => document.querySelector('[data-page=alarms]')?.click() }, '🔔 Ver alarmes'),
      h('button', { class: 'btn primary eng-only', onclick: () => { p.alarms.push({ id: uid('al'), tag: p.tags[0]?.name || '', condition: '>', limit: 0, message: 'Novo alarme', priority: 'media' }); markDirty(); renderAlarmConfig(); } }, '+ Novo alarme')),
    canEdit() ? '' : h('div', { class: 'note' }, isProduction() ? 'Projeto em produção: configuração travada. Volte para o modo edição para alterar os alarmes.' : 'Modo leitura: só Engenharia altera os alarmes.'),
    h('p', { class: 'hint', style: { margin: 0 } }, 'Cada alarme vigia um tag: quando a condição é verdadeira, aparece em "Alarmes" e na faixa vermelha da operação. Clique em "Salvar" para aplicar.'),
    tableOf('config', ['Tag', 'Condição', 'Limite', 'Mensagem', 'Prioridade', ''], cfgBody),
    h('p', { class: 'hint' }, 'Arraste a divisória do cabeçalho para mudar a largura da coluna (duplo clique volta ao automático).'));
  readOnly(alarmCfgRoot);
  resizableTables(alarmCfgRoot, 'alarmes-cfg');
}

function renderAlarmLists() {
  if (!activeBody) return;
  const { active = [], history = [] } = state.alarms;
  if (activeCount) {
    const un = active.filter((x) => !x.acked).length;
    activeCount.textContent = active.length ? `(${active.length}${un ? `, ${un} sem reconhecer` : ''})` : '(nenhum)';
    activeCount.className = 'sec-count' + (un ? ' prio-alta' : '');
  }
  const dt = (t) => new Date(t).toLocaleString('pt-BR');
  activeBody.replaceChildren(...active.map((a) => h('tr', { class: a.acked ? '' : 'unacked' },
    h('td', {}, dt(a.since)), h('td', { class: 'prio-' + a.priority }, a.priority.toUpperCase()), h('td', {}, a.message), h('td', {}, a.tag),
    h('td', { class: 'val' }, fmtVal(a.value)), h('td', {}, a.cleared ? 'Normalizado' : 'Ativo', a.acked ? ' · reconhecido' : ''),
    h('td', {}, a.acked || !can(LV.OPERATOR) ? null : h('button', { class: 'btn small', onclick: () => ackAlarm(a.id) }, 'Reconhecer')))));
  if (!active.length) activeBody.append(h('tr', {}, h('td', { colspan: 7, class: 'hint' }, 'Nenhum alarme ativo ✔')));
  histBody.replaceChildren(...history.map((e) => h('tr', {},
    h('td', {}, dt(e.ts)), h('td', {}, e.event), h('td', { class: 'prio-' + e.priority }, e.priority), h('td', {}, e.message), h('td', {}, fmtVal(e.value)), h('td', {}, e.user || ''))));
}
