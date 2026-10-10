/**
 * Estadísticas del panel: cifras del periodo elegido, actualizadas solas cada 30 segundos.
 * Gráficas en SVG hechas a mano (sin librerías). Cada gráfica tiene su tabla ("Ver datos") y se puede usar con el teclado.
 * Los nombres y textos que llegan del servidor se escriben con textContent, nunca como HTML.
 */
import { api, poll, fill, h, state } from './core.js';
import { acct } from './session.js';

const REFRESH_MS = 30000;
const PRESETS = [
  ['today', 'Hoy'],
  ['week', 'Esta semana'],
  ['7', 'Últimos 7 días'],
  ['15', 'Últimos 15 días'],
  ['30', 'Últimos 30 días'],
  ['60', 'Últimos 60 días'],
  ['90', 'Últimos 90 días'],
  ['custom', 'Rango de fechas'],
];
const CHANNEL_NAMES = { whatsapp: 'WhatsApp', webchat: 'Chat web', email: 'Correo', telegram: 'Telegram', messenger: 'Messenger', instagram: 'Instagram' };
const KIND_NAMES = { decision: 'Respuestas', summary: 'Resúmenes', transcription: 'Transcripciones', import: 'Importaciones de conocimiento', report: 'Reportes' };
const ROLE_NAMES = { admin: 'Administrador', agent: 'Operador' };

const nf = new Intl.NumberFormat('es-MX');
const usdf = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const fmt = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : nf.format(Math.round(Number(n))));
const usd = (n) => usdf.format(Number(n) || 0);
const minutesText = (m) => {
  if (m === null || m === undefined) return 'Sin datos';
  if (m < 60) return `${Number(m).toFixed(1)} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
};
const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
/** Días que se rotulan en el eje X: cada cierto paso, y siempre el último sin encimarse con el anterior. */
function xTicks(n) {
  const step = Math.max(1, Math.ceil(n / 7));
  const ticks = [];
  for (let i = 0; i < n; i += step) ticks.push(i);
  if (n > 1 && ticks[ticks.length - 1] !== n - 1) {
    if (n - 1 - ticks[ticks.length - 1] < step * 0.6) ticks[ticks.length - 1] = n - 1;
    else ticks.push(n - 1);
  }
  return ticks;
}
/** Techo "bonito" para el eje Y (1, 2, 5 × 10^n). */
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/* ------------------------------- Tooltip (uno para toda la vista) ------------------------------- */
let tip = null;
function tipEl() {
  if (!tip) {
    tip = h('div', { class: 'stats-tip', role: 'tooltip', hidden: true });
    document.body.append(tip);
  }
  return tip;
}
function tipShow(clientX, clientY, nodes) {
  const el = tipEl();
  el.replaceChildren(...nodes);
  el.hidden = false;
  const w = el.offsetWidth;
  const left = clientX + 14 + w > window.innerWidth ? clientX - w - 14 : clientX + 14;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, clientY - 12)}px`;
}
function tipHide() {
  if (tip) tip.hidden = true;
}
const tipKey = (cssVar) => h('i', { class: 'stats-key', style: `background: var(${cssVar})` });

/** Cruce con teclado y ratón: el tooltip muestra todas las series de ese día, no solo la que se señala. */
function attachCursor(root, n, onIndex, hide) {
  let active = Math.max(0, n - 1);
  const nearest = (e) => {
    const pt = root.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(root.getScreenCTM().inverse());
  };
  root.addEventListener('pointermove', (e) => {
    const p = nearest(e);
    active = Math.min(n - 1, Math.max(0, Math.round(((p.x - onIndex.left) / onIndex.width) * (n - 1))));
    onIndex.show(active, e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', () => hide());
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    active = Math.min(n - 1, Math.max(0, active + (e.key === 'ArrowRight' ? 1 : -1)));
    const r = root.getBoundingClientRect();
    onIndex.show(active, r.left + r.width / 2, r.top + 24);
  });
  root.addEventListener('focus', () => {
    const r = root.getBoundingClientRect();
    onIndex.show(active, r.left + r.width / 2, r.top + 24);
  });
  root.addEventListener('blur', () => hide());
}

/** Línea con 2 a 3 series: leyenda siempre, etiqueta directa solo al final de cada línea, cruce y tooltip. */
function lineChart(rows, series, label) {
  const W = 640;
  const H = 230;
  const m = { l: 46, r: 96, t: 12, b: 28 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = rows.length;
  const max = niceMax(Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0))));
  const x = (i) => (n > 1 ? m.l + (i * pw) / (n - 1) : m.l + pw / 2);
  const y = (v) => m.t + ph - (v / max) * ph;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'stats-chart', role: 'img', 'aria-label': label, tabindex: 0, preserveAspectRatio: 'xMidYMid meet' });

  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    const yy = y(v);
    root.append(svg('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: 'stats-gridline' }));
    root.append(svg('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'stats-axis' }, fmt(v)));
  }
  for (const i of xTicks(n)) {
    root.append(svg('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', class: 'stats-axis' }, shortDate(rows[i].date)));
  }
  for (const s of series) {
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(r[s.key]) || 0).toFixed(1)}`).join(' ');
    root.append(svg('path', { d, class: 'stats-line', style: `stroke: var(${s.css})` }));
  }
  // Etiquetas directas al final: si dos se pisan, la de abajo se queda solo en la leyenda y el tooltip.
  const last = rows[n - 1] || {};
  const ends = series.map((s) => ({ s, v: Number(last[s.key]) || 0 })).map((e) => ({ ...e, yy: y(e.v) })).sort((a, b) => a.yy - b.yy);
  let lastY = -99;
  for (const e of ends) {
    if (e.yy - lastY < 14) continue;
    lastY = e.yy;
    root.append(svg('circle', { cx: x(n - 1), cy: e.yy, r: 4, class: 'stats-dot', style: `fill: var(${e.s.css})` }));
    root.append(svg('text', { x: x(n - 1) + 9, y: e.yy + 4, class: 'stats-end' }, `${fmt(e.v)}`));
  }
  const cross = svg('line', { class: 'stats-cross', y1: m.t, y2: m.t + ph, style: 'display: none' });
  const dots = series.map((s) => svg('circle', { r: 4, class: 'stats-dot', style: `fill: var(${s.css}); display: none` }));
  root.append(cross, ...dots);
  const show = (i, cx, cy) => {
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.style.display = '';
    series.forEach((s, k) => {
      dots[k].setAttribute('cx', x(i));
      dots[k].setAttribute('cy', y(Number(rows[i][s.key]) || 0));
      dots[k].style.display = '';
    });
    const row = rows[i];
    tipShow(cx, cy, [
      h('strong', { class: 'stats-tip-day' }, longDate(row.date)),
      ...series.map((s) => h('div', { class: 'stats-tip-row' }, tipKey(s.css), h('span', { class: 'muted' }, s.label), h('strong', {}, fmt(row[s.key])))),
    ]);
  };
  const hide = () => {
    cross.style.display = 'none';
    dots.forEach((d) => (d.style.display = 'none'));
    tipHide();
  };
  attachCursor(root, n, { left: m.l, width: pw, show }, hide);
  return root;
}

/** Barras de una sola serie (un color): cada barra es su propio objetivo de cruce. */
function barChart(rows, key, label, css, ariaLabel) {
  const W = 640;
  const H = 200;
  const m = { l: 46, r: 12, t: 14, b: 28 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = rows.length;
  const max = niceMax(Math.max(1, ...rows.map((r) => Number(r[key]) || 0)));
  const y = (v) => m.t + ph - (v / max) * ph;
  const band = pw / Math.max(1, n);
  const barW = Math.min(24, Math.max(3, band - 2));
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'stats-chart', role: 'img', 'aria-label': ariaLabel, tabindex: 0 });
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'stats-gridline' }));
    root.append(svg('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'stats-axis' }, fmt(v)));
  }
  const labelled = new Set(xTicks(n));
  const bars = rows.map((r, i) => {
    const v = Number(r[key]) || 0;
    const cx = m.l + band * i + band / 2;
    const top = y(v);
    const base = m.t + ph;
    const rad = Math.min(4, (base - top) / 2);
    const x0 = cx - barW / 2;
    const x1 = cx + barW / 2;
    const d = v > 0
      ? `M${x0},${base} L${x0},${top + rad} Q${x0},${top} ${x0 + rad},${top} L${x1 - rad},${top} Q${x1},${top} ${x1},${top + rad} L${x1},${base} Z`
      : '';
    const bar = svg('path', { d, class: 'stats-bar', style: `fill: var(${css})` });
    root.append(bar);
    if (labelled.has(i)) root.append(svg('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'stats-axis' }, shortDate(r.date)));
    return bar;
  });
  // El valor más alto se etiqueta en su punta; los demás van en el tooltip y en la tabla.
  const peak = rows.reduce((best, r, i) => (Number(r[key]) > Number(rows[best][key]) ? i : best), 0);
  if (Number(rows[peak]?.[key]) > 0) root.append(svg('text', { x: m.l + band * peak + band / 2, y: y(Number(rows[peak][key])) - 6, 'text-anchor': 'middle', class: 'stats-end' }, fmt(rows[peak][key])));
  const show = (i, cx, cy) => {
    tipShow(cx, cy, [h('strong', { class: 'stats-tip-day' }, longDate(rows[i].date)), h('div', { class: 'stats-tip-row' }, tipKey(css), h('span', { class: 'muted' }, label), h('strong', {}, fmt(rows[i][key])))]);
    bars.forEach((b, k) => b.classList.toggle('is-hot', k === i));
  };
  const hide = () => {
    tipHide();
    bars.forEach((b) => b.classList.remove('is-hot'));
  };
  attachCursor(root, n, { left: m.l, width: pw, show }, hide);
  return root;
}

/** Tabla de respaldo de una gráfica: misma información, sin depender del color ni del cursor. */
function dataTable(headers, rows) {
  return h('details', { class: 'stats-data' },
    h('summary', {}, 'Ver datos en tabla'),
    h('div', { class: 'table-scroll' },
      h('table', {},
        h('thead', {}, h('tr', {}, headers.map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: i ? 'num' : '' }, c))))))));
}

/** Barras horizontales apiladas por persona: dos series (por turnos, manuales) con su hueco de 2 px. */
function teamBars(people) {
  const max = Math.max(1, ...people.map((p) => p.a + p.b));
  return h('div', { class: 'stats-hbars' }, people.map((p) =>
    h('div', { class: 'stats-hbar-row' },
      h('span', { class: 'stats-hbar-name' }, p.name),
      h('div', { class: 'stats-hbar-track' },
        h('div', { class: 'stats-hbar-stack', style: `width: ${((p.a + p.b) / max) * 100}%` },
          p.a ? h('span', { class: 'stats-seg', style: `flex: ${p.a}; background: var(--s1)`, title: `Por turnos: ${fmt(p.a)}`, tabindex: 0 }) : null,
          p.b ? h('span', { class: 'stats-seg', style: `flex: ${p.b}; background: var(--s2)`, title: `Manuales: ${fmt(p.b)}`, tabindex: 0 }) : null)),
      h('strong', { class: 'stats-hbar-total' }, fmt(p.a + p.b)))));
}

/** Tarjeta de cifra: valor, variación frente al periodo anterior (con signo y color) y un dato de apoyo. */
function tile(label, cur, { display = fmt(cur), prev, up = 'good', sub = null, alert = false } = {}) {
  let delta = null;
  if (prev !== undefined && prev !== null) {
    const c = Number(cur) || 0;
    const before = Number(prev) || 0;
    if (before === 0 && c === 0) delta = h('span', { class: 'stats-delta muted' }, 'Sin cambio');
    else if (before === 0) delta = h('span', { class: 'stats-delta muted' }, 'Nuevo en este periodo');
    else {
      const pct = Math.round(((c - before) / before) * 100);
      const rising = pct > 0;
      const good = up === 'good' ? rising : !rising;
      delta = h('span', { class: `stats-delta ${pct === 0 ? 'muted' : good ? 'is-good' : 'is-bad'}` }, `${rising ? '▲' : pct < 0 ? '▼' : '•'} ${Math.abs(pct)}% vs periodo anterior`);
    }
  }
  return h('div', { class: 'card stats-tile' },
    h('div', { class: 'small muted' }, label),
    h('div', { class: 'stats-value' }, display),
    delta,
    sub ? h('div', { class: 'small muted' }, sub) : null,
    alert ? h('div', { class: 'small stats-warn' }, '⚠ Revisa los registros de envío') : null);
}

/* ------------------------------------ Vista ------------------------------------ */

export async function viewAnalytics(root, params = new URLSearchParams()) {
  const picked = { range: params.get('range') || '7', from: params.get('from') || '', to: params.get('to') || '' };
  const frame = h('div', { class: 'stats-frame' });
  const stamp = h('span', { class: 'small muted', 'aria-live': 'polite' }, 'Cargando…');
  const select = h('select', { 'aria-label': 'Periodo', onchange: (e) => { picked.range = e.target.value; customRow.hidden = picked.range !== 'custom'; if (picked.range !== 'custom') load(false); } },
    PRESETS.map(([v, t]) => h('option', { value: v, selected: v === picked.range }, t)));
  const fromInput = h('input', { type: 'date', 'aria-label': 'Desde', value: picked.from });
  const toInput = h('input', { type: 'date', 'aria-label': 'Hasta', value: picked.to });
  const customRow = h('div', { class: 'row', hidden: picked.range !== 'custom' },
    h('label', { class: 'small muted' }, 'Desde ', fromInput), h('label', { class: 'small muted' }, 'hasta ', toInput),
    h('button', { class: 'small', onclick: () => { picked.from = fromInput.value; picked.to = toInput.value; load(false); } }, 'Aplicar'));

  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Estadísticas'), h('div', { class: 'row' }, stamp,
      h('button', { class: 'small', onclick: () => load(false) }, 'Actualizar'))),
    h('div', { class: 'row stats-filters' }, select, customRow),
    frame);

  let loadedOnce = false;
  let seq = 0;
  async function load(silent) {
    const mine = ++seq;
    if (loadedOnce) frame.style.opacity = '0.6'; // se mantiene el cuadro anterior mientras llegan los datos (sin parpadeo)
    try {
      const q = new URLSearchParams({ range: picked.range });
      if (picked.range === 'custom') {
        q.set('from', picked.from);
        q.set('to', picked.to);
      }
      const data = await api('GET', `/api/analytics?${q}${acct('&')}`);
      if (mine !== seq) return; // llegó una respuesta más nueva: esta ya no hace falta
      render(data);
      loadedOnce = true;
      stamp.textContent = `Actualizado ${new Date().toLocaleTimeString('es-MX')} · se actualiza solo cada ${REFRESH_MS / 1000} s`;
    } catch (e) {
      if (mine === seq && !silent) stamp.textContent = `No se pudieron cargar las estadísticas: ${e?.message ?? e}`;
    } finally {
      if (mine === seq) frame.style.opacity = '';
    }
  }

  function render(d) {
    const t = d.totals;
    const p = d.previous;
    const pl = d.period;
    const prevLabel = `${shortDate(pl.prev_from)} a ${shortDate(pl.prev_to)}`;
    const rows = d.daily.map((r) => ({ date: r.date, received: r.messages_received, bot: r.messages_sent_bot, human: r.messages_sent_human, nuevas: r.conversations_new, citas: r.appointments }));
    const people = d.team.users.map((u) => ({ name: u.name, a: u.round_robin, b: u.manual, u }));
    const team = d.team;
    const kpis = h('div', { class: 'stats-kpis' },
      tile('Conversaciones nuevas', t.conversations_new, { prev: p.conversations_new, sub: `${fmt(t.conversations_answered_by_bot)} atendidas por el asistente` }),
      tile('Mensajes recibidos', t.messages_received, { prev: p.messages_received, sub: `${fmt(t.messages_sent)} enviados en total` }),
      tile('Respuestas del asistente', t.messages_sent_bot, { sub: `en ${fmt(t.conversations_answered_by_bot)} conversaciones` }),
      tile('Respuestas de personas', t.messages_sent_human, { sub: `en ${fmt(t.conversations_answered_by_people)} conversaciones` }),
      tile('Citas en el periodo', t.appointments, { prev: p.appointments, sub: `${fmt(t.appointments_confirmed)} confirmadas · ${fmt(t.appointments_completed)} completadas · ${fmt(t.appointments_cancelled)} canceladas · ${fmt(t.appointments_no_show)} no llegaron` }),
      tile('Primera respuesta', t.first_response_minutes, { display: minutesText(t.first_response_minutes), sub: `promedio de ${fmt(t.first_response_samples)} conversaciones` }),
      tile('Costo de IA', t.ai_cost_usd, { display: usd(t.ai_cost_usd), prev: p.ai_cost_usd, up: 'bad', sub: `${fmt(t.ai_runs)} llamadas` }),
      tile('Abiertas ahora', t.conversations_open_now, { sub: `${fmt(t.conversations_waiting_people_now)} esperan a una persona` }),
      tile('Sin persona asignada', t.conversations_unassigned_now, { sub: 'conversaciones abiertas' }),
      tile('Citas próximas 7 días', t.appointments_upcoming_7d, { sub: 'confirmadas' }),
      tile('Mensajes fallidos', t.messages_failed, { sub: 'en el periodo', alert: t.messages_failed > 0 }));

    const allMetrics = h('div', { class: 'stats-kpis' });
    const tiles = [...kpis.children];
    const primary = new Set([0, 4, 5, 6]);
    tiles.forEach((el, i) => { if (!primary.has(i)) allMetrics.append(el); });
    let expanded = false;
    const preference = `cp-stats-all:${state.me.user.id}:${state.accountId}`;
    try { expanded = localStorage.getItem(preference) === '1'; } catch { /* sin almacenamiento */ }
    const extraMetrics = h('details', { class: 'card', open: expanded, ontoggle: () => { try { localStorage.setItem(preference, extraMetrics.open ? '1' : '0'); } catch { /* sin almacenamiento */ } } }, h('summary', {}, 'Todas las métricas de operación'), allMetrics);
    const attention = t.messages_failed || t.conversations_waiting_people_now ? h('div', { class: 'banner warn' }, `${fmt(t.conversations_waiting_people_now)} conversaciones esperan a una persona · ${fmt(t.messages_failed)} mensajes fallidos en el periodo`, ' ', h('a', { href: '#/conversations?status=human' }, 'Atender conversaciones')) : null;
    const lineSeries = [
      { key: 'received', label: 'Recibidos', css: '--s1', short: 'Recibidos' },
      { key: 'bot', label: 'Asistente', css: '--s2', short: 'Asistente' },
      { key: 'human', label: 'Personas', css: '--s3', short: 'Personas' },
    ];
    const activity = h('div', { class: 'card stats-chart-card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Mensajes por día'), h('span', { class: 'small muted' }, `${pl.days} días · ${pl.timezone}`)),
      h('div', { class: 'stats-legend', role: 'list' }, lineSeries.map((s) => h('span', { class: 'stats-legend-item', role: 'listitem' }, h('i', { class: 'stats-key-line', style: `background: var(${s.css})` }), s.label))),
      rows.length ? lineChart(rows, lineSeries, 'Mensajes recibidos y enviados por día') : h('p', { class: 'muted' }, 'Sin datos en este periodo.'),
      dataTable(['Día', 'Recibidos', 'Asistente', 'Personas'], rows.map((r) => [shortDate(r.date), fmt(r.received), fmt(r.bot), fmt(r.human)])));

    const newPerDay = h('div', { class: 'card stats-chart-card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Conversaciones nuevas por día'), h('span', { class: 'small muted' }, 'una serie')),
      rows.length ? barChart(rows.map((r) => ({ date: r.date, n: r.nuevas })), 'n', 'Conversaciones nuevas', '--s1', 'Conversaciones nuevas por día') : h('p', { class: 'muted' }, 'Sin datos en este periodo.'),
      dataTable(['Día', 'Conversaciones nuevas'], rows.map((r) => [shortDate(r.date), fmt(r.nuevas)])));

    const teamCard = h('div', { class: 'card stats-chart-card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Personas del equipo'), h('span', { class: 'small muted' }, `${fmt(team.round_robin_total)} asignaciones por turnos en el periodo`)),
      h('div', { class: 'stats-legend', role: 'list' },
        h('span', { class: 'stats-legend-item', role: 'listitem' }, h('i', { class: 'stats-key-block', style: 'background: var(--s1)' }), 'Por turnos'),
        h('span', { class: 'stats-legend-item', role: 'listitem' }, h('i', { class: 'stats-key-block', style: 'background: var(--s2)' }), 'Manuales o tomadas')),
      people.length ? teamBars(people) : h('p', { class: 'muted' }, 'Nadie recibió conversaciones en este periodo.'),
      h('div', { class: 'table-scroll' },
        h('table', { class: 'stats-team' },
          h('thead', {}, h('tr', {}, ['Persona', 'Recibidas', 'Por turnos', '% por turnos', 'Manuales', 'Abiertas ahora', 'Mensajes', 'Citas'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
          h('tbody', {}, [
            ...d.team.users.map((u) => h('tr', {},
              h('td', {}, h('div', {}, u.name), h('div', { class: 'small muted' }, `${ROLE_NAMES[u.role] || u.role}${u.active ? '' : ' · inactiva'}`)),
              h('td', { class: 'num' }, fmt(u.conversations_received)),
              h('td', { class: 'num' }, fmt(u.round_robin)),
              h('td', { class: 'num' }, u.round_robin_share === null ? '—' : `${u.round_robin_share}%`),
              h('td', { class: 'num' }, fmt(u.manual)),
              h('td', { class: 'num' }, fmt(u.open_now)),
              h('td', { class: 'num' }, fmt(u.messages_sent)),
              h('td', { class: 'num' }, fmt(u.appointments)))),
            h('tr', {},
              h('td', { class: 'muted' }, 'Sin persona asignada ahora'), h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—'),
              h('td', { class: 'num' }, fmt(team.unassigned_open_now)), h('td', { class: 'num' }, '—'), h('td', { class: 'num' }, '—')),
          ]))));

    const services = d.services.length
      ? dataTable(['Servicio', 'Citas'], d.services.map((s) => [s.name, fmt(s.total)]))
      : null;
    const citas = h('div', { class: 'card stats-chart-card' },
      h('h2', {}, 'Citas'),
      h('p', { class: 'small muted' }, `${fmt(t.appointments_by_bot)} agendadas por el asistente · ${fmt(t.appointments_by_people)} desde el panel`),
      h('div', { class: 'stats-status' },
        statusRow('ok', 'Completadas', t.appointments_completed),
        statusRow('ok', 'Confirmadas', t.appointments_confirmed),
        statusRow('warn', 'No llegaron', t.appointments_no_show),
        statusRow('neutral', 'Canceladas', t.appointments_cancelled)),
      services ? h('h2', { class: 'small' }, 'Servicios más pedidos') : null,
      services ? h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Servicio'), h('th', { class: 'num' }, 'Citas'))), h('tbody', {}, d.services.map((s) => h('tr', {}, h('td', {}, s.name), h('td', { class: 'num' }, fmt(s.total))))))) : h('p', { class: 'muted' }, 'Sin citas en este periodo.'));

    const channelsCard = h('div', { class: 'card stats-chart-card' },
      h('h2', {}, 'Canales'),
      d.channels.length
        ? h('div', { class: 'table-scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Canal', 'Nuevas', 'Recibidos', 'Enviados'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
          h('tbody', {}, d.channels.map((c) => h('tr', {}, h('td', {}, h('div', {}, c.name), (CHANNEL_NAMES[c.type] || c.type) !== c.name ? h('div', { class: 'small muted' }, CHANNEL_NAMES[c.type] || c.type) : null), h('td', { class: 'num' }, fmt(c.new_conversations)), h('td', { class: 'num' }, fmt(c.received)), h('td', { class: 'num' }, fmt(c.sent)))))))
        : h('p', { class: 'muted' }, 'La cuenta todavía no tiene canales.'));

    const aiCard = h('div', { class: 'card stats-chart-card' },
      h('h2', {}, 'Costo de IA'),
      h('p', { class: 'small muted' }, `${usd(t.ai_cost_usd)} en el periodo · ${fmt(t.ai_runs)} llamadas`),
      d.ai_by_kind.length
        ? h('div', { class: 'table-scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Tipo', 'Llamadas', 'Costo'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
          h('tbody', {}, d.ai_by_kind.map((k) => h('tr', {}, h('td', {}, KIND_NAMES[k.kind] || k.kind), h('td', { class: 'num' }, fmt(k.runs)), h('td', { class: 'num' }, usd(k.cost)))))))
        : h('p', { class: 'muted' }, 'Sin llamadas de IA en este periodo.'));

    fill(frame,
      h('p', { class: 'small muted' }, `Periodo: ${shortDate(pl.from)} a ${shortDate(pl.to)} (${pl.days} ${pl.days === 1 ? 'día' : 'días'}) · comparado con ${prevLabel}`),
      h('h2', { class: 'stats-section' }, 'Periodo elegido'),
      attention, kpis, extraMetrics,
      h('div', { class: 'stats-grid' }, activity, newPerDay),
      h('h2', { class: 'stats-section' }, 'Equipo'),
      teamCard,
      h('div', { class: 'stats-grid' }, citas, channelsCard, aiCard));
  }

  /** Estado de una cita con icono y texto: el color nunca va solo. */
  function statusRow(kind, label, n) {
    const icon = kind === 'ok' ? '✔' : kind === 'warn' ? '⚠' : '•';
    return h('div', { class: `stats-status-row is-${kind}` }, h('span', { class: 'stats-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label), h('strong', {}, fmt(n)));
  }

  await load(false);
  poll(() => load(true), REFRESH_MS, root);
}
