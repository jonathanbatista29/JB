// Página de histórico: gráfico de tendências do banco de dados, histórico de alarmes e configuração.
import { state, h, api, toast, markDirty, can, canEdit, findTag, confirmBox, LV } from './state.js';

const COLORS = ['#2d8cff', '#f39c12', '#2ecc71', '#e74c3c', '#9b59b6', '#1abc9c', '#e67e22', '#ecf0f1'];
const PERIODS = [['900000', 'Últimos 15 min'], ['3600000', 'Última 1 hora'], ['28800000', 'Últimas 8 horas'], ['86400000', 'Últimas 24 horas'],
  ['604800000', 'Últimos 7 dias'], ['2592000000', 'Últimos 30 dias'], ['custom', 'Personalizado']];

let root, view = 'trend';
const sel = { tags: null, period: '3600000', from: 0, to: 0 };
let data = null;

export function initHistory(el) {
  root = el;
  el.classList.add('list-page');
}

const fmtDate = (t) => new Date(t).toLocaleString('pt-BR');
const fmtNum = (v) => (v == null ? '---' : String(Math.round(v * 100) / 100).replace('.', ','));
const toLocalInput = (t) => { const d = new Date(t - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

function loggedTags() {
  return (state.project?.tags || []).filter((t) => t.log && t.type !== 'string');
}

function period() {
  if (sel.period === 'custom') return { from: sel.from, to: sel.to };
  const to = Date.now();
  return { from: to - Number(sel.period), to };
}

export function renderHistory() {
  if (!state.project) return;
  const tabs = h('div', { class: 'subtabs' },
    [['trend', '📈 Tendências'], ['alarms', '🔔 Alarmes'], ...(canEdit() ? [['config', '⚙ Configuração']] : [])].map(([id, txt]) =>
      h('button', { class: view === id ? 'active' : '', onclick: () => { view = id; renderHistory(); } }, txt)));
  const body = h('div', { class: 'hist-body' });
  root.replaceChildren(h('div', { class: 'head' }, h('h2', {}, 'Histórico'), tabs), body);
  if (view === 'trend') renderTrend(body);
  else if (view === 'alarms') renderAlarmHist(body);
  else renderConfig(body);
}

// ---------- Tendências ----------
function periodControls(onChange) {
  const fromIn = h('input', { type: 'datetime-local', value: toLocalInput(sel.from || Date.now() - 3600000) });
  const toIn = h('input', { type: 'datetime-local', value: toLocalInput(sel.to || Date.now()) });
  const custom = h('span', { class: 'custom-range' + (sel.period === 'custom' ? '' : ' hidden') }, fromIn, ' até ', toIn);
  const apply = () => {
    if (sel.period === 'custom') {
      sel.from = new Date(fromIn.value).getTime();
      sel.to = new Date(toIn.value).getTime();
      if (!(sel.from < sel.to)) return toast('Período inválido', 'err');
    }
    onChange();
  };
  fromIn.addEventListener('change', apply);
  toIn.addEventListener('change', apply);
  const shift = (dir) => {
    const { from, to } = period();
    const span = to - from;
    sel.period = 'custom';
    sel.from = from + dir * span;
    sel.to = to + dir * span;
    renderHistory();
  };
  return h('div', { class: 'hist-controls' },
    h('select', { onchange: (e) => {
      sel.period = e.target.value;
      if (sel.period === 'custom') { const p = { from: Date.now() - 3600000, to: Date.now() }; sel.from = p.from; sel.to = p.to; renderHistory(); return; }
      onChange();
      custom.classList.add('hidden');
    } }, PERIODS.map(([v, t]) => h('option', { value: v, selected: v === sel.period }, t))),
    custom,
    h('button', { class: 'btn small', title: 'Período anterior', onclick: () => shift(-1) }, '◀'),
    h('button', { class: 'btn small', title: 'Próximo período', onclick: () => shift(1) }, '▶'),
    h('button', { class: 'btn small', onclick: apply }, '⟳ Atualizar'));
}

function renderTrend(body) {
  const tags = loggedTags();
  if (!tags.length) {
    body.append(h('div', { class: 'note' }, 'Nenhum tag está sendo registrado. Na aba Tags, marque a coluna "Histórico" dos tags desejados e clique em Salvar.'));
    return;
  }
  if (!sel.tags) sel.tags = tags.slice(0, 3).map((t) => t.name);
  sel.tags = sel.tags.filter((n) => tags.some((t) => t.name === n));

  const canvas = h('canvas', { class: 'hist-canvas' });
  const tip = h('div', { class: 'hist-tip hidden' });
  const summary = h('tbody');
  const chartBox = h('div', { class: 'hist-chart' }, canvas, tip);
  const sumNote = h('p', { class: 'hint', style: { margin: 0 } });

  const load = async () => {
    const { from, to } = period();
    if (!sel.tags.length) { data = null; draw(); summary.replaceChildren(); return; }
    try {
      data = await api(`api/history?tags=${encodeURIComponent(sel.tags.join(','))}&from=${from}&to=${to}&points=${Math.max(200, Math.min(2000, chartBox.clientWidth || 800))}`);
    } catch (e) {
      return toast(e.message, 'err');
    }
    draw();
    const su = Object.values(data.summaryUntil || {});
    sumNote.textContent = su.length ? `Antes de ${fmtDate(Math.max(...su))} o gráfico mostra o resumo por minuto (linha = média, faixa = mínimo e máximo).` : '';
    summary.replaceChildren(...sel.tags.map((n, i) => {
      const pts = (data.series[n] || []).filter((p) => p[1] != null);
      const t = findTag(n);
      const avg = pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null;
      return h('tr', {},
        h('td', {}, h('i', { class: 'swatch', style: { background: COLORS[i % COLORS.length] } }), n),
        h('td', {}, t?.description || ''),
        h('td', { class: 'val' }, fmtNum(pts.length ? Math.min(...pts.map((p) => p[2])) : null)),
        h('td', { class: 'val' }, fmtNum(avg)),
        h('td', { class: 'val' }, fmtNum(pts.length ? Math.max(...pts.map((p) => p[3])) : null)),
        h('td', {}, String(pts.length)));
    }));
  };

  // Desenho do gráfico. Arrastar seleciona um trecho para dar zoom; duplo clique volta.
  let geom = null, dragX = null, hoverX = null;
  function draw() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const { from, to } = data ? { from: data.from, to: data.to } : period();
    const all = data ? sel.tags.flatMap((n) => (data.series[n] || []).flatMap((p) => [p[2], p[3]])).filter((v) => v != null) : [];
    let min = all.length ? Math.min(...all) : 0, max = all.length ? Math.max(...all) : 100;
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.05; min -= pad; max += pad;
    const L = 56, R = 12, T = 10, B = 26;
    const x = (t) => L + ((t - from) / (to - from)) * (W - L - R);
    const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    geom = { L, R, W, from, to, x };

    g.font = '11px sans-serif'; g.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const v = min + ((max - min) * i) / 5, yy = y(v);
      g.strokeStyle = '#2f3a4a'; g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke();
      g.fillStyle = '#8796aa'; g.fillText(fmtNum(v), 4, yy + 4);
    }
    const span = to - from;
    for (let i = 0; i <= 6; i++) {
      const t = from + (span * i) / 6, xx = x(t);
      g.strokeStyle = '#232c38'; g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, H - B); g.stroke();
      const d = new Date(t);
      const lbl = span > 2 * 86400000 ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleTimeString('pt-BR', span > 3600000 ? { hour: '2-digit', minute: '2-digit' } : undefined);
      g.fillStyle = '#8796aa'; g.textAlign = i === 0 ? 'left' : i === 6 ? 'right' : 'center'; g.fillText(lbl, xx, H - 8);
    }
    g.textAlign = 'left';
    if (!data) return;

    sel.tags.forEach((n, i) => {
      const pts = data.series[n] || [];
      const color = COLORS[i % COLORS.length];
      const step = findTag(n)?.type === 'bool';
      // Faixa mínimo/máximo quando vários valores caem no mesmo ponto
      if (data.bucket > 1 && !step) {
        g.fillStyle = color + '22';
        for (const p of pts) if (p[2] != null && p[3] > p[2]) g.fillRect(x(p[0]), y(p[3]), Math.max(1, x(p[0] + data.bucket) - x(p[0])), y(p[2]) - y(p[3]));
      }
      g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
      let prev = null;
      for (const p of pts) {
        if (p[1] == null) { prev = null; continue; }
        const xx = x(p[0]), yy = y(p[1]);
        if (!prev) g.moveTo(xx, yy);
        else if (step) { g.lineTo(xx, prev[1]); g.lineTo(xx, yy); }
        else g.lineTo(xx, yy);
        prev = [xx, yy];
      }
      // Para tags que só gravam na mudança, estende a última linha até o fim do período
      if (prev && to <= Date.now() + 1000) g.lineTo(x(Math.min(to, Date.now())), prev[1]);
      g.stroke();
    });

    if (dragX != null && hoverX != null) {
      g.fillStyle = '#2d8cff33';
      g.fillRect(Math.min(dragX, hoverX), T, Math.abs(hoverX - dragX), H - T - B);
    } else if (hoverX != null && hoverX >= L) {
      g.strokeStyle = '#ffffff55'; g.beginPath(); g.moveTo(hoverX, T); g.lineTo(hoverX, H - B); g.stroke();
    }
  }

  const tAt = (px) => geom.from + ((px - geom.L) / (geom.W - geom.L - geom.R)) * (geom.to - geom.from);
  function showTip(px) {
    if (!data || !geom || px < geom.L) { tip.classList.add('hidden'); return; }
    const t = tAt(px);
    const rows = sel.tags.map((n, i) => {
      const pts = data.series[n] || [];
      let best = null;
      for (const p of pts) { if (p[0] <= t) best = p; else break; }
      return h('div', {}, h('i', { class: 'swatch', style: { background: COLORS[i % COLORS.length] } }), `${n}: `, h('b', {}, fmtNum(best?.[1])));
    });
    tip.replaceChildren(h('div', { class: 'hint' }, fmtDate(t)), ...rows);
    tip.classList.remove('hidden');
    tip.style.left = Math.min(px + 12, chartBox.clientWidth - 190) + 'px';
  }
  const posX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  canvas.addEventListener('pointerdown', (e) => { dragX = posX(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { hoverX = posX(e); draw(); if (dragX == null) showTip(hoverX); else tip.classList.add('hidden'); });
  canvas.addEventListener('pointerleave', () => { hoverX = null; tip.classList.add('hidden'); draw(); });
  canvas.addEventListener('pointerup', (e) => {
    const x2 = posX(e), x1 = dragX;
    dragX = null;
    if (x1 != null && Math.abs(x2 - x1) > 8 && geom) {
      const a = tAt(Math.min(x1, x2)), b = tAt(Math.max(x1, x2));
      sel.period = 'custom'; sel.from = Math.round(a); sel.to = Math.round(b);
      renderHistory();
    } else draw();
  });
  canvas.addEventListener('dblclick', () => { sel.period = '3600000'; renderHistory(); });

  const tagPicker = h('div', { class: 'tag-picker' }, tags.map((t) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: sel.tags.includes(t.name), onchange: (e) => {
      if (e.target.checked) { if (sel.tags.length >= 8) { e.target.checked = false; return toast('Máximo de 8 tags no gráfico'); } sel.tags.push(t.name); }
      else sel.tags = sel.tags.filter((n) => n !== t.name);
      load();
    } }), t.name)));

  const csv = () => {
    if (!sel.tags.length) return;
    const { from, to } = period();
    location.href = `api/history.csv?tags=${encodeURIComponent(sel.tags.join(','))}&from=${from}&to=${to}`;
  };

  body.append(
    h('div', { class: 'hist-controls' }, periodControls(load), h('button', { class: 'btn small', onclick: csv }, '⬇ Exportar CSV')),
    tagPicker,
    chartBox,
    h('p', { class: 'hint', style: { margin: 0 } }, 'Arraste no gráfico para ampliar um trecho · duplo clique volta para a última hora.'),
    sumNote,
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Tag', 'Descrição', 'Mínimo', 'Média', 'Máximo', 'Pontos'].map((c) => h('th', {}, c)))), summary)));
  new ResizeObserver(() => draw()).observe(chartBox);
  load();
}

// ---------- Alarmes ----------
function renderAlarmHist(body) {
  const tbody = h('tbody');
  const text = h('input', { type: 'text', placeholder: 'Filtrar por mensagem ou tag…', style: { maxWidth: '260px' } });
  let rows = [];
  const load = async () => {
    const { from, to } = period();
    try {
      rows = await api(`api/alarm-history?from=${from}&to=${to}&limit=5000&text=${encodeURIComponent(text.value)}`);
    } catch (e) {
      return toast(e.message, 'err');
    }
    tbody.replaceChildren(...rows.map((e) => h('tr', {},
      h('td', { style: { whiteSpace: 'nowrap' } }, fmtDate(e.ts)), h('td', {}, e.event), h('td', { class: 'prio-' + e.priority }, e.priority),
      h('td', {}, e.message), h('td', {}, e.tag), h('td', {}, e.value ?? ''), h('td', {}, e.user || ''))));
    if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: 7, class: 'hint' }, 'Nenhum evento no período.')));
  };
  text.addEventListener('change', load);
  const csv = () => {
    const lines = ['data_hora;evento;prioridade;mensagem;tag;valor;usuario',
      ...rows.map((e) => [fmtDate(e.ts), e.event, e.priority, e.message, e.tag, e.value ?? '', e.user || ''].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))];
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' })), download: 'alarmes.csv' });
    document.body.append(a); a.click(); a.remove();
  };
  body.append(
    h('div', { class: 'hist-controls' }, periodControls(load), text, h('button', { class: 'btn small', onclick: csv }, '⬇ Exportar CSV')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Data/hora', 'Evento', 'Prioridade', 'Mensagem', 'Tag', 'Valor', 'Usuário'].map((c) => h('th', {}, c)))), tbody)));
  load();
}

// ---------- Configuração (Engenharia) ----------
async function renderConfig(body) {
  const cfg = (state.project.historian ||= {});
  cfg.rawDays ??= 14; cfg.summaryDays ??= 365; cfg.heartbeatSec ??= 60; cfg.maxSizeMB ??= 0;
  const num = (key, label, min, max, hint) => h('label', { class: 'field' }, label, h('input', { type: 'number', min, max, value: cfg[key],
    onchange: (e) => {
      cfg[key] = Math.min(max, Math.max(min, Math.round(Number(e.target.value)) || min));
      if (cfg.summaryDays < cfg.rawDays) cfg.summaryDays = cfg.rawDays;
      e.target.value = cfg[key];
      markDirty();
      estimate();
    } }), hint ? h('small', { class: 'hint' }, hint) : '');
  const MB = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2).replace('.', ',')} GB`
    : b >= 1048576 ? `${(b / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.round(b / 1024)} KB`);
  const stats = h('div', { class: 'hint' }, 'Carregando…');
  const est = h('div', { class: 'note' });
  const usageBox = h('div');
  let perDay = 0, loggedCount = 0;
  // Estimativa de espaço com a configuração atual (dados completos + resumo por minuto).
  function estimate() {
    if (!perDay && !loggedCount) { est.textContent = 'Sem dados suficientes para estimar (o histórico grava há menos de 1 dia).'; return; }
    const raw = perDay * cfg.rawDays;
    const sum = loggedCount * 1440 * 42 * Math.max(0, cfg.summaryDays - cfg.rawDays);
    est.replaceChildren(h('b', {}, `Estimativa: ~${MB(raw + sum)}`),
      ` (${MB(raw)} de dados completos em ${cfg.rawDays} dias + ${MB(sum)} de resumo em ${Math.max(0, cfg.summaryDays - cfg.rawDays)} dias)`,
      cfg.maxSizeMB && raw + sum > cfg.maxSizeMB * 1048576 ? h('div', { class: 'prio-media' }, `Passa do limite de ${cfg.maxSizeMB} MB: os dados mais antigos serão apagados antes do prazo.`) : '');
  }
  const showUsage = async (btn) => {
    btn.disabled = true;
    try {
      const u = await api('api/history/usage');
      usageBox.replaceChildren(h('div', { class: 'table-wrap', style: { maxHeight: '45vh', overflow: 'auto' } }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['Tag', 'Ocupa', 'Grava por dia', 'Registros completos', 'Resumos (min)', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, u.map((x) => h('tr', {},
          h('td', {}, x.tag), h('td', { class: 'val' }, MB(x.bytes)), h('td', {}, MB(x.perDayBytes)),
          h('td', {}, x.raw.toLocaleString('pt-BR')), h('td', {}, x.summary.toLocaleString('pt-BR')),
          h('td', { class: 'hint' }, x.logged ? (x.lastDay > 86400 ? 'muito rápido: use banda ou intervalo' : '') : 'não está mais registrando')))))));
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  };
  const compact = async (btn) => {
    if (!(await confirmBox('Compactar o histórico agora? Reorganiza o arquivo e devolve ao disco todo o espaço livre. Em bancos grandes pode levar alguns segundos, e a IHM fica parada nesse tempo.'))) return;
    btn.disabled = true; btn.textContent = 'Compactando...';
    try { const r = await api('api/history/compact', { method: 'POST' }); toast(`Compactado: ${MB(r.before)} → ${MB(r.after)}`, 'ok'); } catch (e) { toast(e.message, 'err'); }
    renderHistory();
  };
  const usageBtn = h('button', { class: 'btn small', onclick: () => showUsage(usageBtn) }, '📊 Ocupação por tag');
  const compactBtn = h('button', { class: 'btn small', onclick: () => compact(compactBtn) }, '🗜 Compactar agora');
  body.append(h('div', { class: 'cards' },
    h('div', { class: 'card' },
      h('h3', { class: 'section-title', style: { margin: 0 } }, 'Quanto tempo guardar'),
      num('rawDays', 'Dados completos por (dias)', 1, 3650, 'Todos os valores gravados, com detalhe total.'),
      num('summaryDays', 'Resumo por minuto por (dias)', 1, 3650, 'Depois dos dados completos, fica só a média, o mínimo e o máximo de cada minuto (ocupa muito menos).'),
      num('heartbeatSec', 'Gravar no mínimo a cada (segundos), mesmo sem mudança', 1, 3600),
      num('maxSizeMB', 'Limite de tamanho (MB, 0 = sem limite)', 0, 10485760, 'Se passar, apaga os dados mais antigos primeiro.'),
      est,
      h('p', { class: 'hint', style: { margin: 0 } }, 'Clique em "Salvar" no topo para aplicar. Na aba Tags: quais tags registrar, banda morta e intervalo mínimo de cada um.')),
    h('div', { class: 'card' },
      h('h3', { class: 'section-title', style: { margin: 0 } }, 'Situação do banco'),
      stats,
      h('div', { class: 'prop-actions' }, usageBtn, compactBtn))),
    usageBox);
  try {
    const s = await api('api/history/stats');
    loggedCount = s.logged.length;
    try {
      const u = await api('api/history/usage');
      perDay = u.filter((x) => x.logged).reduce((a, x) => a + x.perDayBytes, 0);
    } catch {}
    estimate();
    stats.replaceChildren(
      h('div', {}, `Tamanho do arquivo: ${MB(s.sizeBytes)}`, s.sizeBytes - s.usedBytes > 1048576 ? ` (${MB(s.sizeBytes - s.usedBytes)} livres para reaproveitar)` : ''),
      h('div', {}, `Registros completos: ${s.samples.toLocaleString('pt-BR')}${s.firstRaw ? ' desde ' + fmtDate(s.firstRaw) : ''}`),
      h('div', {}, `Resumos por minuto: ${s.summaries.toLocaleString('pt-BR')}${s.firstSummary ? ' desde ' + fmtDate(s.firstSummary) : ''}`),
      h('div', {}, `Resumo atualizado até: ${s.rollupUntil ? fmtDate(s.rollupUntil) : '—'}`),
      s.lastTrim ? h('div', { class: 'prio-media' }, `Limite de tamanho atingido em ${fmtDate(s.lastTrim.ts)}: dados ${s.lastTrim.kind} apagados até ${fmtDate(s.lastTrim.until)}`) : '',
      h('div', {}, `Tags registrados agora: ${s.logged.length ? s.logged.join(', ') : 'nenhum'}`));
  } catch (e) {
    stats.textContent = e.message;
  }
}
