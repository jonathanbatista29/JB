// Biblioteca de objetos de tela (widgets).
// Cada widget define: nome, ícone, tamanho padrão, propriedades editáveis e render().
// render(w, rt) devolve o elemento; el._update() é chamado quando os valores mudam.
import { state, on, h, api, toast, tagValue, tagQuality, findTag, writeTag, keypad, confirmBox, can, emit, ackAlarm, tagWriteLevel, LV, LEVEL_NAMES } from './state.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const fmt = (v, dec) => {
  if (v == null || v === '') return '---';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(num(dec, 0)).replace('.', ',');
};
const isOn = (v) => v === true || (typeof v === 'number' && v !== 0) || v === '1' || v === 'true';
const pct = (v, min, max) => Math.max(0, Math.min(100, ((num(v) - min) / (max - min || 1)) * 100));
const boolFor = (tag, on) => (findTag(tag)?.type === 'bool' ? on : on ? 1 : 0);

// Nível mínimo para usar um objeto de comando. "Padrão": operador para comandos, todos para navegar.
function minLevel(w) {
  if (w.type === 'navbtn') return Number(navButton(w.props.ref)?.level) || 0;
  const own = Number(w.props.level) || 0;
  if (w.type === 'button' && (w.props.action === 'navigate' || w.props.action === 'back')) return own;
  return Math.max(LV.OPERATOR, own, w.props.tag ? tagWriteLevel(w.props.tag) : LV.OPERATOR);
}
function allowed(w) {
  const min = minLevel(w);
  if (can(min)) return true;
  emit('needLogin', { min, reason: `Este comando exige nível ${LEVEL_NAMES[min]}` });
  return false;
}

const P = {
  tag: { key: 'tag', label: 'Tag', kind: 'tag', full: true },
  text: { key: 'text', label: 'Texto (Enter = nova linha)', kind: 'textarea', full: true },
  fontSize: { key: 'fontSize', label: 'Fonte (px)', kind: 'number' },
  color: { key: 'color', label: 'Cor do texto', kind: 'color' },
  bg: { key: 'bg', label: 'Cor de fundo', kind: 'color' },
  min: { key: 'min', label: 'Mínimo', kind: 'number' },
  max: { key: 'max', label: 'Máximo', kind: 'number' },
  unit: { key: 'unit', label: 'Unidade', kind: 'text' },
  decimals: { key: 'decimals', label: 'Casas decimais', kind: 'number' },
  blink: { key: 'blink', label: 'Piscar quando ligado', kind: 'bool', full: true },
  rotate: { key: 'rotate', label: 'Rotação do texto', kind: 'select', full: true, options: [
    ['0', 'Normal (horizontal)'], ['90', '90° — lê de cima para baixo'], ['270', '270° — lê de baixo para cima'], ['180', '180° — de cabeça para baixo']] },
  level: { key: 'level', label: 'Nível mínimo para usar', kind: 'select', full: true,
    options: [['', 'Padrão'], ['1', 'Operador'], ['2', 'Manutenção'], ['3', 'Engenharia'], ['4', 'Administrador']] },
};

// Biblioteca de botões de tela do projeto (cada um chama uma tela e pode ser usado em várias telas).
export const navButton = (id) => (state.project?.navButtons || []).find((b) => b.id === id);
export const NAVBTN_DEFAULTS = { text: 'TELA', screen: '', bg: '#2d6cdf', color: '#ffffff', fontSize: 16, level: '' };

export const WIDGETS = {
  navbtn: {
    name: 'Botão de tela', icon: '⇨', size: [160, 50], group: 'Botões de tela', hidden: true,
    defaults: { ref: '' }, props: [], command: true,
    render(w, rt) {
      const b = navButton(w.props.ref);
      const p = { ...NAVBTN_DEFAULTS, ...(b || {}) };
      const el = h('button', { class: 'w-button w-navbtn', style: { background: p.bg, color: p.color, fontSize: p.fontSize + 'px' } },
        b ? p.text : '(botão excluído)');
      el._update = () => el.classList.toggle('current', Boolean(b?.screen) && b.screen === rt.current);
      if (rt.runtime) el.addEventListener('click', () => {
        if (!b?.screen) return toast('Este botão ainda não tem tela de destino', 'err');
        if (!allowed(w)) return;
        rt.navigate(b.screen);
      });
      return el;
    },
  },

  label: {
    name: 'Texto', icon: 'T', size: [200, 40], group: 'Básico',
    defaults: { text: 'Texto', fontSize: 18, color: '#ffffff', bg: 'transparent', bold: false, align: 'left' },
    props: [P.text, P.fontSize, P.color, P.bg,
      { key: 'align', label: 'Alinhamento', kind: 'select', options: [['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']] },
      { key: 'bold', label: 'Negrito', kind: 'bool' }, P.rotate],
    render(w) {
      const p = w.props;
      return h('div', { class: 'w-label', style: { width: '100%', fontSize: p.fontSize + 'px', color: p.color, background: p.bg, fontWeight: p.bold ? 700 : 400,
        justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[p.align] || 'flex-start', textAlign: p.align } }, p.text);
    },
  },

  rect: {
    name: 'Retângulo / Painel', icon: '▭', size: [200, 120], group: 'Básico',
    defaults: { bg: '#252e3b', border: '#3a4656', borderWidth: 1, radius: 6 },
    props: [P.bg, { key: 'border', label: 'Cor da borda', kind: 'color' }, { key: 'borderWidth', label: 'Espessura borda', kind: 'number' }, { key: 'radius', label: 'Arredondamento', kind: 'number' }],
    render(w) {
      const p = w.props;
      return h('div', { class: 'w-rect', style: { background: p.bg, border: `${num(p.borderWidth)}px solid ${p.border}`, borderRadius: num(p.radius) + 'px' } });
    },
  },

  button: {
    name: 'Botão', icon: '⏺', size: [140, 50], group: 'Comandos',
    defaults: { text: 'BOTÃO', tag: '', action: 'momentary', value: 1, screen: '', bg: '#2d6cdf', color: '#ffffff', fontSize: 16, confirm: false },
    props: [P.text,
      { key: 'action', label: 'Ação', kind: 'select', full: true, options: [
        ['momentary', 'Pulso (liga enquanto pressionado)'], ['toggle', 'Alternar (liga/desliga)'], ['set', 'Ligar (set)'], ['reset', 'Desligar (reset)'],
        ['value', 'Escrever valor fixo'], ['navigate', 'Ir para outra tela'], ['back', 'Voltar à tela anterior']] },
      P.tag, { key: 'value', label: 'Valor a escrever', kind: 'number', showIf: (p) => p.action === 'value' },
      { key: 'screen', label: 'Tela de destino', kind: 'screen', full: true, showIf: (p) => p.action === 'navigate' },
      P.bg, P.color, P.fontSize, P.rotate, { key: 'confirm', label: 'Pedir confirmação', kind: 'bool' }, P.level],
    command: true,
    render(w, rt) {
      const p = w.props;
      const el = h('button', { class: 'w-button', style: { background: p.bg, color: p.color, fontSize: p.fontSize + 'px' } }, h('span', { class: 'btn-txt rot-target' }, p.text));
      el._update = () => {
        const showState = p.tag && ['toggle', 'set', 'reset', 'momentary'].includes(p.action);
        el.classList.toggle('on', Boolean(showState && isOn(tagValue(p.tag))));
      };
      if (!rt.runtime) return el;
      const ask = async () => !p.confirm || confirmBox(`Confirma "${p.text}"?`);
      if (p.action === 'momentary') {
        const up = () => { if (el._down) { el._down = false; el.classList.remove('pressed'); writeTag(p.tag, boolFor(p.tag, false)).catch(() => {}); } };
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); if (!allowed(w)) return; el.setPointerCapture?.(e.pointerId); el._down = true; el.classList.add('pressed'); writeTag(p.tag, boolFor(p.tag, true)).catch(() => {}); });
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('lostpointercapture', up);
      } else {
        el.addEventListener('click', async () => {
          if (!allowed(w)) return;
          if (p.action === 'navigate') return rt.navigate(p.screen);
          if (p.action === 'back') return rt.back();
          if (!(await ask())) return;
          const v = p.action === 'toggle' ? boolFor(p.tag, !isOn(tagValue(p.tag)))
            : p.action === 'set' ? boolFor(p.tag, true)
            : p.action === 'reset' ? boolFor(p.tag, false) : num(p.value);
          writeTag(p.tag, v).catch(() => {});
        });
      }
      return el;
    },
  },

  switch: {
    name: 'Chave liga/desliga', icon: '⇆', size: [140, 44], group: 'Comandos',
    defaults: { tag: '', onText: 'LIGADO', offText: 'DESLIGADO', color: '#ffffff', confirm: false },
    props: [P.tag, { key: 'onText', label: 'Texto ligado', kind: 'text' }, { key: 'offText', label: 'Texto desligado', kind: 'text' }, P.color, { key: 'confirm', label: 'Pedir confirmação', kind: 'bool' }, P.level],
    command: true,
    render(w, rt) {
      const p = w.props;
      const txt = h('span', { class: 'txt' });
      const el = h('div', { class: 'w-switch', style: { color: p.color } }, h('div', { class: 'track' }, h('div', { class: 'knob' })), txt);
      el._update = () => {
        const on = isOn(tagValue(p.tag));
        el.classList.toggle('on', on);
        txt.textContent = on ? p.onText : p.offText;
      };
      if (rt.runtime) el.addEventListener('click', async () => {
        if (!allowed(w)) return;
        const next = !isOn(tagValue(p.tag));
        if (p.confirm && !(await confirmBox(`Confirma ${next ? p.onText : p.offText}?`))) return;
        writeTag(p.tag, boolFor(p.tag, next)).catch(() => {});
      });
      return el;
    },
  },

  input: {
    name: 'Entrada numérica', icon: '123', size: [150, 40], group: 'Comandos',
    defaults: { tag: '', min: 0, max: 100, decimals: 0, unit: '', fontSize: 18 },
    props: [P.tag, P.min, P.max, P.decimals, P.unit, P.fontSize, P.level],
    command: true,
    render(w, rt) {
      const p = w.props;
      const val = h('span', {});
      const el = h('div', { class: 'w-input', style: { fontSize: p.fontSize + 'px' } }, val, p.unit ? h('small', {}, p.unit) : null);
      el._update = () => { val.textContent = fmt(tagValue(p.tag), p.decimals); val.classList.toggle('bad-q', tagQuality(p.tag) === 'bad'); };
      if (rt.runtime) el.addEventListener('click', async () => {
        if (!allowed(w)) return;
        const v = await keypad({ title: findTag(p.tag)?.description || p.tag, value: tagValue(p.tag), min: num(p.min, -Infinity), max: num(p.max, Infinity), decimals: num(p.decimals) });
        if (v != null) writeTag(p.tag, v).catch(() => {});
      });
      return el;
    },
  },

  slider: {
    name: 'Controle deslizante', icon: '⎯', size: [300, 40], group: 'Comandos',
    defaults: { tag: '', min: 0, max: 100, step: 1 },
    props: [P.tag, P.min, P.max, { key: 'step', label: 'Passo', kind: 'number' }, P.level],
    command: true,
    render(w, rt) {
      const p = w.props;
      const inp = h('input', { type: 'range', min: num(p.min), max: num(p.max, 100), step: num(p.step, 1) });
      const el = h('div', { class: 'w-slider' }, inp);
      el._update = () => { if (!inp._drag) inp.value = num(tagValue(p.tag)); };
      if (rt.runtime) {
        inp.addEventListener('pointerdown', (e) => { if (!allowed(w)) { e.preventDefault(); return; } inp._drag = true; });
        inp.addEventListener('change', () => { inp._drag = false; writeTag(p.tag, Number(inp.value)).catch(() => {}); });
      } else inp.disabled = true;
      return el;
    },
  },

  lamp: {
    name: 'Sinaleiro / Lâmpada', icon: '◉', size: [200, 44], group: 'Indicadores',
    defaults: { tag: '', text: 'Status', onColor: '#2ecc71', offColor: '#3b4554', color: '#ffffff', fontSize: 15, blink: false, invert: false },
    props: [P.tag, P.text, { key: 'onColor', label: 'Cor ligado', kind: 'color' }, { key: 'offColor', label: 'Cor desligado', kind: 'color' }, P.color, P.fontSize, P.blink,
      { key: 'invert', label: 'Inverter lógica', kind: 'bool', full: true }, P.rotate],
    render(w) {
      const p = w.props;
      const bulb = h('div', { class: 'bulb' });
      const el = h('div', { class: 'w-lamp', style: { color: p.color, fontSize: p.fontSize + 'px' } }, bulb, p.text ? h('span', { class: 'txt' }, p.text) : null);
      if (!p.text) Object.assign(el.style, { background: 'none', border: 'none', justifyContent: 'center', padding: 0 });
      el._update = () => {
        const on = isOn(tagValue(p.tag)) !== Boolean(p.invert);
        const size = Math.max(10, Math.min(w.h - 12, w.w - 12));
        Object.assign(bulb.style, { width: size + 'px', height: size + 'px', background: on ? p.onColor : p.offColor, boxShadow: on ? `0 0 12px ${p.onColor}, inset 0 -3px 6px rgba(0,0,0,.3)` : '' });
        bulb.classList.toggle('blink', on && Boolean(p.blink));
      };
      return el;
    },
  },

  display: {
    name: 'Valor numérico', icon: '0.0', size: [200, 40], group: 'Indicadores',
    defaults: { tag: '', label: 'Valor', decimals: 1, unit: '', fontSize: 18, lo: '', hi: '' },
    props: [P.tag, { key: 'label', label: 'Rótulo', kind: 'text' }, P.unit, P.decimals, P.fontSize,
      { key: 'lo', label: 'Alarme se abaixo de', kind: 'number' }, { key: 'hi', label: 'Alarme se acima de', kind: 'number' }],
    render(w) {
      const p = w.props;
      const val = h('span', { class: 'val' });
      const el = h('div', { class: 'w-display', style: { fontSize: p.fontSize + 'px' } }, p.label ? h('span', { class: 'lbl' }, p.label) : null, val);
      el._update = () => {
        const v = tagValue(p.tag);
        val.textContent = fmt(v, p.decimals) + (p.unit ? ' ' + p.unit : '');
        const n = Number(v);
        el.classList.toggle('alarm', (p.lo !== '' && p.lo != null && n < Number(p.lo)) || (p.hi !== '' && p.hi != null && n > Number(p.hi)));
        el.classList.toggle('bad', tagQuality(p.tag) === 'bad');
      };
      return el;
    },
  },

  multistate: {
    name: 'Texto por estado', icon: '☰', size: [200, 40], group: 'Indicadores',
    defaults: { tag: '', states: '0=PARADO:#7f8c8d\n1=RODANDO:#2ecc71\n2=FALHA:#e74c3c', fontSize: 16 },
    props: [P.tag, { key: 'states', label: 'Estados (valor=texto:cor, um por linha)', kind: 'textarea', full: true }, P.fontSize, P.rotate],
    render(w) {
      const p = w.props;
      const map = String(p.states || '').split('\n').map((l) => l.match(/^\s*([^=]+)=([^:]*)(?::(.*))?$/)).filter(Boolean)
        .map((m) => ({ v: m[1].trim(), text: m[2].trim(), color: (m[3] || '#555').trim() }));
      const el = h('div', { class: 'w-multistate', style: { fontSize: p.fontSize + 'px' } });
      el._update = () => {
        let v = tagValue(p.tag);
        if (typeof v === 'boolean') v = v ? 1 : 0;
        const s = map.find((m) => String(Number(m.v)) === String(Number(v)) || m.v === String(v));
        el.textContent = s ? s.text : `? (${fmt(v)})`;
        el.style.background = s ? s.color : '#555';
      };
      return el;
    },
  },

  bar: {
    name: 'Barra gráfica', icon: '▮', size: [60, 200], group: 'Indicadores',
    defaults: { tag: '', min: 0, max: 100, color: '#3498db', orientation: 'vertical', showValue: true, decimals: 0, unit: '' },
    props: [P.tag, P.min, P.max, { key: 'color', label: 'Cor', kind: 'color' },
      { key: 'orientation', label: 'Orientação', kind: 'select', options: [['vertical', 'Vertical'], ['horizontal', 'Horizontal']] },
      P.decimals, P.unit, { key: 'showValue', label: 'Mostrar valor', kind: 'bool' }],
    render(w) {
      const p = w.props;
      const fill = h('div', { class: 'fill', style: { background: p.color } });
      const txt = h('div', { class: 'txt' });
      const el = h('div', { class: 'w-bar' }, fill, p.showValue ? txt : null);
      el._update = () => {
        const v = tagValue(p.tag), x = pct(v, num(p.min), num(p.max, 100)) + '%';
        if (p.orientation === 'horizontal') Object.assign(fill.style, { width: x, height: '100%' });
        else Object.assign(fill.style, { height: x, width: '100%' });
        txt.textContent = fmt(v, p.decimals) + (p.unit ? ' ' + p.unit : '');
      };
      return el;
    },
  },

  tank: {
    name: 'Tanque', icon: '⛁', size: [120, 200], group: 'Indicadores',
    defaults: { tag: '', min: 0, max: 100, color: '#3498db', unit: '%', decimals: 0 },
    props: [P.tag, P.min, P.max, { key: 'color', label: 'Cor do líquido', kind: 'color' }, P.unit, P.decimals],
    render(w) {
      const p = w.props;
      const fill = h('div', { class: 'fill', style: { background: `linear-gradient(90deg, ${p.color}cc, ${p.color}, ${p.color}aa)` } });
      const txt = h('div', { class: 'txt' });
      const el = h('div', { class: 'w-tank' }, h('div', { class: 'body' }, fill, txt));
      el._update = () => { const v = tagValue(p.tag); fill.style.height = pct(v, num(p.min), num(p.max, 100)) + '%'; txt.textContent = fmt(v, p.decimals) + ' ' + (p.unit || ''); };
      return el;
    },
  },

  gauge: {
    name: 'Manômetro / Gauge', icon: '◔', size: [200, 150], group: 'Indicadores',
    defaults: { tag: '', min: 0, max: 100, unit: '', decimals: 0, color: '#2d8cff' },
    props: [P.tag, P.min, P.max, P.unit, P.decimals, { key: 'color', label: 'Cor', kind: 'color' }],
    render(w) {
      const p = w.props;
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 200 140');
      svg.setAttribute('class', 'fill-svg');
      const arc = (a0, a1, r) => {
        const pt = (a) => [100 + r * Math.cos(a), 110 + r * Math.sin(a)];
        const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
        return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
      };
      const A0 = Math.PI * 0.8, A1 = Math.PI * 2.2;
      svg.innerHTML = `<path d="${arc(A0, A1, 80)}" stroke="#2f3a4a" stroke-width="16" fill="none" stroke-linecap="round"/>
        <path class="g-val" stroke="${p.color}" stroke-width="16" fill="none" stroke-linecap="round"/>
        <text class="g-txt" x="100" y="108" text-anchor="middle" font-size="28" font-weight="700" fill="#fff"></text>
        <text x="100" y="132" text-anchor="middle" font-size="14" fill="#8796aa">${escapeXml(p.unit || '')}</text>
        <text x="30" y="138" text-anchor="middle" font-size="11" fill="#8796aa">${num(p.min)}</text>
        <text x="170" y="138" text-anchor="middle" font-size="11" fill="#8796aa">${num(p.max, 100)}</text>`;
      const el = h('div', { style: { width: '100%' } }, svg);
      el._update = () => {
        const v = tagValue(p.tag);
        const f = pct(v, num(p.min), num(p.max, 100)) / 100;
        svg.querySelector('.g-val').setAttribute('d', f > 0.001 ? arc(A0, A0 + (A1 - A0) * f, 80) : '');
        svg.querySelector('.g-txt').textContent = fmt(v, p.decimals);
      };
      return el;
    },
  },

  image: {
    name: 'Imagem', icon: '🖼', size: [200, 150], group: 'Básico',
    defaults: { src: '', srcOn: '', tag: '', fit: 'contain', radius: 0, opacity: 100, invert: false },
    props: [
      { key: 'src', label: 'Imagem', kind: 'image', full: true },
      { key: 'fit', label: 'Ajuste', kind: 'select', full: true, options: [['contain', 'Caber inteira (sem cortar)'], ['cover', 'Preencher (corta as bordas)'], ['fill', 'Esticar']] },
      { key: 'radius', label: 'Arredondamento', kind: 'number' }, { key: 'opacity', label: 'Opacidade (%)', kind: 'number' },
      { key: 'tag', label: 'Trocar de imagem pelo tag (opcional)', kind: 'tag', full: true },
      { key: 'srcOn', label: 'Imagem quando o tag ligar', kind: 'image', full: true, showIf: (p) => Boolean(p.tag) },
      { key: 'invert', label: 'Inverter lógica', kind: 'bool', full: true, showIf: (p) => Boolean(p.tag) }],
    render(w) {
      const p = w.props;
      const img = h('img', { class: 'w-image', alt: '', draggable: 'false',
        style: { objectFit: p.fit || 'contain', borderRadius: num(p.radius) + 'px', opacity: Math.max(0, Math.min(100, num(p.opacity, 100))) / 100 } });
      const empty = h('div', { class: 'w-image-empty' }, '🖼 Escolha uma imagem');
      const el = h('div', { style: { width: '100%', height: '100%', position: 'relative' } }, img, empty);
      el._update = () => {
        const on = p.tag ? isOn(tagValue(p.tag)) !== Boolean(p.invert) : false;
        const file = on && p.srcOn ? p.srcOn : p.src;
        const url = file ? 'imagens/' + encodeURIComponent(file) : '';
        if (img.getAttribute('src') !== url) url ? img.setAttribute('src', url) : img.removeAttribute('src');
        img.style.display = url ? '' : 'none';
        empty.style.display = url ? 'none' : '';
      };
      return el;
    },
  },

  // Alarmes na tela: lista dos alarmes ativos ou indicador (contador).
  alarms: {
    name: 'Alarmes (lista / indicador)', icon: '🔔', size: [620, 180], group: 'Indicadores',
    defaults: { mode: 'list', title: 'ALARMES ATIVOS', minPriority: 'baixa', showTime: true, showPriority: true, showTag: false, showValue: true,
      showAck: true, maxRows: 0, fontSize: 14, okText: 'SEM ALARMES' },
    props: [
      { key: 'mode', label: 'Tipo', kind: 'select', full: true, options: [['list', 'Lista de alarmes ativos'], ['indicator', 'Indicador (quantidade de alarmes)']] },
      { key: 'title', label: 'Título', kind: 'text', full: true },
      { key: 'minPriority', label: 'Mostrar a partir da prioridade', kind: 'select', full: true, options: [['baixa', 'Todas'], ['media', 'Média e alta'], ['alta', 'Só alta']] },
      { key: 'showTime', label: 'Coluna hora', kind: 'bool', showIf: (p) => p.mode !== 'indicator' },
      { key: 'showPriority', label: 'Coluna prioridade', kind: 'bool', showIf: (p) => p.mode !== 'indicator' },
      { key: 'showTag', label: 'Coluna tag', kind: 'bool', showIf: (p) => p.mode !== 'indicator' },
      { key: 'showValue', label: 'Coluna valor', kind: 'bool', showIf: (p) => p.mode !== 'indicator' },
      { key: 'showAck', label: 'Botão reconhecer', kind: 'bool', full: true },
      { key: 'maxRows', label: 'Máx. de linhas (0 = todas)', kind: 'number', showIf: (p) => p.mode !== 'indicator' },
      P.fontSize,
      { key: 'okText', label: 'Texto sem alarmes', kind: 'text', full: true }],
    render(w, rt) {
      const p = w.props;
      const RANK = { baixa: 1, media: 2, alta: 3 };
      const el = h('div', { class: 'w-alarms ' + (p.mode === 'indicator' ? 'indicator' : 'list'), style: { fontSize: p.fontSize + 'px' } });
      const dt = (t) => new Date(t).toLocaleTimeString('pt-BR');
      // No editor sem alarmes ativos, mostra um exemplo para ver como fica.
      const sample = [{ id: 'x1', since: Date.now() - 60000, priority: 'alta', message: 'Exemplo: temperatura alta', tag: 'Temperatura', value: 81.2, acked: false },
        { id: 'x2', since: Date.now() - 300000, priority: 'media', message: 'Exemplo: nível alto', tag: 'Nivel', value: 92, acked: true }];
      const list = () => {
        const all = state.alarms?.active || [];
        const src = !rt.runtime && !all.length ? sample : all;
        return src.filter((a) => (RANK[a.priority] || 2) >= (RANK[p.minPriority] || 1))
          .sort((a, b) => (Number(a.acked) - Number(b.acked)) || (RANK[b.priority] - RANK[a.priority]) || (b.since - a.since));
      };
      const ack = (id, e) => { e.stopPropagation(); if (rt.runtime) ackAlarm(id); };
      function draw() {
        const items = list();
        const unacked = items.filter((a) => !a.acked).length;
        if (p.mode === 'indicator') {
          el.className = 'w-alarms indicator ' + (unacked ? 'alarm unacked' : items.length ? 'alarm' : 'ok');
          el.replaceChildren(
            h('div', { class: 'ind-title' }, p.title || 'ALARMES'),
            h('div', { class: 'ind-count' }, items.length ? String(items.length) : '✓'),
            h('div', { class: 'ind-sub' }, items.length ? (unacked ? `${unacked} sem reconhecer` : 'reconhecidos') : (p.okText || 'SEM ALARMES')),
            p.showAck && unacked ? h('button', { class: 'ind-ack', onclick: (e) => ack('*', e) }, 'Reconhecer') : '');
          return;
        }
        const max = Number(p.maxRows) || 0;
        const shown = max ? items.slice(0, max) : items;
        const cols = [p.showTime && 'Hora', p.showPriority && 'Prior.', 'Mensagem', p.showTag && 'Tag', p.showValue && 'Valor', p.showAck && ''].filter((c) => c !== false);
        el.replaceChildren(
          h('div', { class: 'al-head' }, h('span', {}, p.title || 'ALARMES'),
            h('span', { class: 'al-count' + (unacked ? ' unacked' : '') }, items.length ? `${items.length}${unacked ? ` · ${unacked} sem reconhecer` : ''}` : ''),
            p.showAck && unacked ? h('button', { class: 'al-ackall', onclick: (e) => ack('*', e) }, 'Reconhecer todos') : ''),
          items.length
            ? h('div', { class: 'al-body' }, h('table', {},
              h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
              h('tbody', {}, shown.map((a) => h('tr', { class: `prio-row-${a.priority}${a.acked ? ' acked' : ''}${a.cleared ? ' cleared' : ''}` },
                p.showTime ? h('td', { class: 'al-time' }, dt(a.since)) : '',
                p.showPriority ? h('td', { class: 'al-prio' }, String(a.priority).toUpperCase()) : '',
                h('td', { class: 'al-msg' }, a.message, a.cleared ? h('small', {}, ' (normalizado)') : ''),
                p.showTag ? h('td', {}, a.tag) : '',
                p.showValue ? h('td', { class: 'al-val' }, fmt(a.value, 1)) : '',
                p.showAck ? h('td', {}, a.acked ? h('span', { class: 'al-ok' }, '✓') : h('button', { class: 'al-ack', onclick: (e) => ack(a.id, e) }, 'OK')) : '')))),
              max && items.length > max ? h('div', { class: 'al-more' }, `+ ${items.length - max} alarme(s)`) : '')
            : h('div', { class: 'al-empty' }, '✓ ', p.okText || 'SEM ALARMES'));
      }
      draw();
      const off = on('alarms', draw);
      // Indicador no modo operação: tocar abre a página de alarmes.
      if (rt.runtime && p.mode === 'indicator') el.addEventListener('click', () => document.querySelector('[data-page=alarms]')?.click());
      el._update = () => {};
      el._destroy = off;
      return el;
    },
  },

  symbol: {
    name: 'Motor / Bomba / Válvula', icon: '⚙', size: [90, 90], group: 'Indicadores',
    defaults: { tag: '', symbol: 'motor', onColor: '#2ecc71', offColor: '#7f8c8d', faultTag: '', blink: false },
    props: [P.tag, { key: 'symbol', label: 'Símbolo', kind: 'select', full: true, options: [['motor', 'Motor'], ['pump', 'Bomba'], ['valve', 'Válvula'], ['fan', 'Ventilador']] },
      { key: 'onColor', label: 'Cor ligado', kind: 'color' }, { key: 'offColor', label: 'Cor desligado', kind: 'color' },
      { key: 'faultTag', label: 'Tag de falha (fica vermelho)', kind: 'tag', full: true }, P.blink],
    render(w) {
      const p = w.props;
      const el = h('div', { style: { width: '100%' } });
      el.innerHTML = `<svg viewBox="0 0 100 100" class="fill-svg">${SYMBOLS[p.symbol] || SYMBOLS.motor}</svg>`;
      el._update = () => {
        const on = isOn(tagValue(p.tag)), fault = p.faultTag && isOn(tagValue(p.faultTag));
        const c = fault ? '#e74c3c' : on ? p.onColor : p.offColor;
        el.querySelectorAll('.sf').forEach((n) => n.setAttribute('fill', c));
        el.querySelector('svg').classList.toggle('blink', Boolean(fault || (on && p.blink)));
        el.querySelector('.spin')?.style.setProperty('animation', on && !fault ? 'spin 1s linear infinite' : 'none');
      };
      return el;
    },
  },

  trend: {
    name: 'Gráfico de tendência', icon: '📈', size: [480, 260], group: 'Indicadores',
    defaults: { tags: '', min: 0, max: 100, seconds: 60 },
    props: [{ key: 'tags', label: 'Tags (separados por vírgula)', kind: 'text', full: true }, P.min, P.max, { key: 'seconds', label: 'Janela (segundos)', kind: 'number' }],
    render(w, rt) {
      const p = w.props;
      const colors = ['#2d8cff', '#f39c12', '#2ecc71', '#e74c3c', '#9b59b6', '#1abc9c'];
      const tags = String(p.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      const canvas = h('canvas');
      const el = h('div', { class: 'w-trend' }, canvas,
        h('div', { class: 'legend' }, tags.map((t, i) => h('span', {}, h('i', { style: { background: colors[i % colors.length] } }), t))));
      const win = num(p.seconds, 60) * 1000, min = num(p.min), max = num(p.max, 100);
      tags.forEach((t) => trendTags.add(t));
      if (rt.runtime) prefillTrend(tags.filter((t) => findTag(t)?.log), win);
      const sample = () => draw(Date.now());
      const draw = (now) => {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        if (!W || !H) return;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        const L = 40, R = 8, T = 8, B = 18;
        g.strokeStyle = '#2f3a4a'; g.fillStyle = '#8796aa'; g.font = '11px sans-serif'; g.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
          const y = T + ((H - T - B) * i) / 4;
          g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
          g.fillText(String(Math.round((max - ((max - min) * i) / 4) * 10) / 10), 2, y + 4);
        }
        g.fillText(`-${Math.round(win / 1000)}s`, L, H - 4);
        g.fillText('agora', W - R - 30, H - 4);
        tags.map((t) => trendBuf.get(t) || []).forEach((series, i) => {
          g.strokeStyle = colors[i % colors.length]; g.lineWidth = 2; g.beginPath();
          let started = false;
          for (const [t, v] of series) {
            if (t < now - win) continue;
            if (v == null || !Number.isFinite(v)) { started = false; continue; }
            const x = L + ((t - (now - win)) / win) * (W - L - R);
            const y = T + (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min || 1)) * (H - T - B);
            started ? g.lineTo(x, y) : g.moveTo(x, y);
            started = true;
          }
          g.stroke();
        });
      };
      const timer = setInterval(sample, 500);
      el._destroy = () => clearInterval(timer);
      el._update = () => {};
      requestAnimationFrame(() => draw(Date.now()));
      return el;
    },
  },
};

// Histórico das tendências: amostra continuamente, mesmo com a tela fechada (até 10 min).
const trendTags = new Set();
const trendBuf = new Map();
setInterval(() => {
  const now = Date.now();
  for (const t of trendTags) {
    const v = tagValue(t);
    const arr = trendBuf.get(t) || [];
    arr.push([now, v == null ? null : Number(v)]);
    while (arr.length && arr[0][0] < now - 600000) arr.shift();
    trendBuf.set(t, arr);
  }
}, 500);

// Ao abrir a tela, completa o gráfico com o que já está no banco de histórico.
const prefilled = new Map(); // tag -> início já carregado
async function prefillTrend(tags, win) {
  const from = Date.now() - win;
  const need = tags.filter((t) => !(prefilled.get(t) <= from));
  if (!need.length) return;
  need.forEach((t) => prefilled.set(t, from));
  try {
    const r = await api(`api/history?tags=${encodeURIComponent(need.join(','))}&from=${from}&points=600`);
    for (const t of need) {
      const cur = trendBuf.get(t) || [];
      const first = cur.length ? cur[0][0] : Infinity;
      const old = (r.series[t] || []).filter((p) => p[0] < first).map((p) => [p[0], p[1]]);
      trendBuf.set(t, [...old, ...cur]);
    }
  } catch {
    need.forEach((t) => prefilled.delete(t));
  }
}

const SYMBOLS = {
  motor: `<rect x="10" y="78" width="80" height="10" rx="2" fill="#4a5568"/><circle class="sf" cx="50" cy="45" r="34" stroke="#cfd8e3" stroke-width="3"/>
    <text x="50" y="57" text-anchor="middle" font-size="34" font-weight="700" fill="#fff" font-family="sans-serif">M</text>`,
  pump: `<rect x="15" y="80" width="70" height="10" rx="2" fill="#4a5568"/><circle class="sf" cx="50" cy="46" r="34" stroke="#cfd8e3" stroke-width="3"/>
    <path d="M50 14 L82 46 L50 78" fill="none" stroke="#fff" stroke-width="4"/><rect x="0" y="40" width="16" height="12" fill="#4a5568"/><rect x="50" y="6" width="12" height="10" fill="#4a5568"/>`,
  valve: `<path class="sf" d="M10 25 L50 50 L10 75 Z M90 25 L50 50 L90 75 Z" stroke="#cfd8e3" stroke-width="3"/>
    <line x1="50" y1="50" x2="50" y2="15" stroke="#cfd8e3" stroke-width="4"/><rect x="35" y="8" width="30" height="10" rx="2" fill="#4a5568"/>`,
  fan: `<circle cx="50" cy="50" r="42" fill="#1b222d" stroke="#cfd8e3" stroke-width="3"/>
    <g class="spin" style="transform-origin:50px 50px"><path class="sf" d="M50 50 C40 30 45 12 55 12 C62 14 60 35 50 50 Z M50 50 C70 40 88 45 88 55 C86 62 65 60 50 50 Z M50 50 C60 70 55 88 45 88 C38 86 40 65 50 50 Z M50 50 C30 60 12 55 12 45 C14 38 35 40 50 50 Z"/></g>
    <circle cx="50" cy="50" r="6" fill="#cfd8e3"/>`,
};

const style = document.createElement('style');
style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(style);

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// ---------- Visibilidade por tag ----------
// Qualquer objeto pode sumir da tela conforme um tag (props.hideTag / hideMode / hideValue).
// Sem comunicação (tag com qualidade ruim) o objeto continua visível.
export const HIDE_MODES = [
  ['', 'Sempre visível'],
  ['on', 'Invisível quando o tag ligar (1 / ≠ 0)'],
  ['off', 'Invisível quando o tag desligar (0) — só aparece ligado'],
  ['eq', 'Invisível quando o tag for igual a…'],
  ['neq', 'Invisível quando o tag for diferente de… — só aparece nesse valor'],
];
const sameVal = (v, list) => String(list ?? '').split(/[,;]/).map((x) => x.trim()).filter((x) => x !== '')
  .some((x) => (Number.isFinite(Number(x)) && typeof v !== 'string' ? Number(x) === Number(typeof v === 'boolean' ? (v ? 1 : 0) : v) : x === String(v)));
export function hiddenBy(p) {
  if (!p?.hideTag || !p.hideMode) return false;
  if (tagQuality(p.hideTag) !== 'good') return false;
  const v = tagValue(p.hideTag);
  switch (p.hideMode) {
    case 'on': return isOn(v);
    case 'off': return !isOn(v);
    case 'eq': return sameVal(v, p.hideValue);
    case 'neq': return !sameVal(v, p.hideValue);
    default: return false;
  }
}

// Texto girado: 90° e 270° usam escrita vertical (o texto ocupa a altura do objeto), 180° só vira.
// No botão gira só o texto (.rot-target), para o efeito de apertar e a sombra continuarem certos.
export const isVertical = (r) => String(r) === '90' || String(r) === '270';
function applyRotation(el, r) {
  r = String(r || '0');
  if (r === '0') return;
  el.classList.add('rot-' + r);
  if (isVertical(r)) el.style.writingMode = 'vertical-rl';
  if (r === '180' || r === '270') el.style.transform = 'rotate(180deg)';
}

// Cria o elemento posicionado de um widget dentro da tela.
export function renderWidget(w, rt) {
  const def = WIDGETS[w.type];
  const box = h('div', { class: 'wgt', 'data-id': w.id, style: { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' } });
  if (!def) { box.append(h('div', { class: 'inner' }, `? ${w.type}`)); return box; }
  w.props = { ...def.defaults, ...(w.props || {}) };
  const inner = def.render(w, rt);
  applyRotation(inner.querySelector('.rot-target') || inner, w.props.rotate);
  const wrap = h('div', { class: 'inner' }, inner);
  box.append(wrap);
  const upd = inner._update || (() => {});
  const vis = w.props.hideTag && w.props.hideMode;
  // Na operação o objeto some; no editor fica apagado (para continuar dando para editar).
  if (vis && !rt.runtime) { box.classList.add('has-vis'); box.title = 'Este objeto some na operação conforme o tag ' + w.props.hideTag; }
  box._update = vis ? () => { upd(); box.classList.toggle(rt.runtime ? 'vis-hidden' : 'vis-preview', hiddenBy(w.props)); } : upd;
  box._destroy = inner._destroy || (() => {});
  box._update();
  if (rt.runtime && def.command) {
    box.classList.toggle('locked', !can(minLevel(w)));
    box.title = can(minLevel(w)) ? '' : `Requer nível ${LEVEL_NAMES[minLevel(w)]}`;
  }
  return box;
}

export function newWidget(type, x, y) {
  const def = WIDGETS[type];
  return { id: 'w' + Math.random().toString(36).slice(2, 9), type, x, y, w: def.size[0], h: def.size[1], props: structuredClone(def.defaults) };
}
