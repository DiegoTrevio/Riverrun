import { discardDraft, draftModel, draftNotice, draftVersion } from './editing.js';
import { needAccount } from './admin.js';
import { VARS_HELP, hoursEditor } from './automation.js';
import { saveBar } from './bot.js';
import { api, area, check, clone, field, fill, h, dialog, num, run, select, state, text, toast, confirmAction, ask } from './core.js';
import { render } from './main.js';
import { isAdmin, withAcct } from './session.js';

/* ============================== Agenda ============================== */

const APPT_STATUS = { confirmed: ['green', 'Confirmada'], completed: ['', 'Completada'], no_show: ['orange', 'No asistió'], cancelled: ['red', 'Cancelada'] };

export async function viewAgenda(root, tab, params) {
  root.append(
    h('h1', {}, 'Agenda'),
    h('div', { class: 'tabs' }, [['citas', 'Calendario'], ...(isAdmin() ? [['servicios', 'Servicios']] : []), ['equipo', isAdmin() ? 'Equipo y disponibilidad' : 'Mi disponibilidad']].map(([k, l]) => h('a', { href: `#/agenda/${k}`, class: k === tab ? 'active' : '' }, l))),
  );
  if (needAccount(root)) return;
  const body = h('div');
  root.append(body);
  if (tab === 'servicios') return params.get('id') ? editService(body, params.get('id')) : listServices(body);
  if (tab === 'equipo') return viewTeam(body, params);
  return agendaWeek(body, params);
}

/* ============================== Equipo y disponibilidad ============================== */

const PROVIDER = { google: 'Google Calendar', outlook: 'Outlook' };

/**
 * Horario, días libres y calendario de cada persona. Cada quien conecta su propio calendario (lo autoriza con su cuenta);
 * el administrador ve el de todos y edita la disponibilidad de cualquiera.
 */
async function viewTeam(root, params) {
  const status = params.get('calendario');
  if (status === 'ok') toast('Calendario conectado ✅');
  else if (status === 'cancelado') toast('No se conectó el calendario', true);
  else if (status === 'error') toast(`No se pudo conectar el calendario${params.get('msg') ? `: ${params.get('msg')}` : ''}`, true);
  const [team, mine] = await Promise.all([api('GET', withAcct('/api/team/agenda')), api('GET', '/api/me/calendar').catch(() => null)]);
  root.append(h('div', { class: 'card' }, h('p', { class: 'muted', style: 'margin:0' },
    'Cada persona tiene su horario y sus días libres: el asistente solo ofrece horarios en los que alguien que atiende el servicio está disponible. ',
    'Si conectas tu calendario de Google u Outlook, tus eventos ocupados bloquean tus horarios y las citas que te tocan aparecen en tu calendario.')));
  if (!team.length) root.append(h('p', { class: 'muted' }, 'Aún no hay personas en el equipo.'));
  for (const p of team) root.append(personCard(p, p.id === state.me.user.id ? mine : null));
}

function personCard(p, mine) {
  const m = { own: !!p.hours, hours: p.hours || { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [], sun: [] }, time_off: clone(p.time_off), meeting_url: p.meeting_url || '' };
  const hoursBox = h('div');
  const drawHours = () => fill(hoursBox, m.own ? hoursEditor(m.hours) : h('p', { class: 'small muted' }, 'Sigue el horario del negocio (o el del servicio, si tiene uno).'));
  drawHours();
  const offBox = h('div');
  const draft = { from: '', to: '', note: '' };
  const drawOff = () => fill(offBox,
    m.time_off.length ? h('ul', { style: 'margin:4px 0;padding-left:18px' }, m.time_off.map((o, i) => h('li', {}, o.from === o.to ? o.from : `${o.from} a ${o.to}`, o.note ? ` · ${o.note}` : '', ' ',
      h('button', { class: 'small', onclick: () => { m.time_off.splice(i, 1); drawOff(); } }, 'Quitar')))) : h('p', { class: 'small muted' }, 'Sin días libres registrados.'),
    h('div', { class: 'row' },
      field('Desde', h('input', { type: 'date', value: draft.from, oninput: (e) => (draft.from = e.target.value) })),
      field('Hasta', h('input', { type: 'date', value: draft.to, oninput: (e) => (draft.to = e.target.value) })),
      field('Motivo (opcional)', text(draft, 'note', { placeholder: 'Vacaciones' })),
      h('button', { onclick: () => {
        if (!draft.from) return toast('Elige el primer día libre', true);
        m.time_off.push({ from: draft.from, to: draft.to || draft.from, note: draft.note });
        Object.assign(draft, { from: '', to: '', note: '' });
        drawOff();
      } }, '+ Agregar')));
  drawOff();
  const save = () => run(() => api('PUT', `/api/team/${p.id}/schedule`, { hours: m.own ? m.hours : null, time_off: m.time_off, meeting_url: m.meeting_url.trim() }), 'Disponibilidad guardada ✅');
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, p.name || p.email),
      h('span', { class: 'small muted' }, p.services.length ? `Atiende: ${p.services.map((s) => s.name).join(', ')}` : 'No está asignada a ningún servicio')),
    calendarBox(p, mine),
    h('h3', {}, 'Horario'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.own, onchange: (e) => { m.own = e.target.checked; drawHours(); } }), 'Tiene su propio horario'),
    hoursBox,
    h('h3', {}, 'Días libres'),
    offBox,
    h('h3', {}, 'Videollamadas'),
    field('Enlace fijo de videollamada (opcional)', text(m, 'meeting_url', { type: 'url', placeholder: 'https://zoom.us/j/… o https://meet.google.com/…' }),
      'Con el calendario conectado se crea una sala de Meet o Teams para cada videollamada; si no, se usa este enlace.'),
    h('button', { class: 'primary', onclick: save }, 'Guardar disponibilidad'));
}

/** Calendario de la persona: si es uno mismo, conectar o desconectar; si es otra, solo su estado (y desconectar, si administra). */
function calendarBox(p, mine) {
  const c = p.calendar;
  const line = c.connected
    ? [h('span', { class: 'badge green' }, `✓ ${PROVIDER[c.provider]}`), c.email ? ` ${c.email}` : '', c.last_error ? h('div', { class: 'small', style: 'color:var(--danger)' }, `Último error: ${c.last_error}`) : null]
    : [h('span', { class: 'badge' }, 'Sin calendario conectado')];
  const connect = async (provider) => {
    const r = await run(() => api('POST', '/api/me/calendar/connect', { provider }));
    if (r?.url) location.href = r.url;
  };
  const actions = [];
  if (mine) {
    if (!c.connected) {
      for (const provider of ['google', 'outlook']) if (mine.available?.[provider]) actions.push(h('button', { onclick: () => connect(provider) }, `Conectar mi ${PROVIDER[provider]}`));
      if (!actions.length) actions.push(h('span', { class: 'small muted' }, 'Esta instalación aún no tiene Google ni Outlook configurados.'));
    } else {
      actions.push(h('label', { class: 'check', style: 'margin:0' }, h('input', { type: 'checkbox', checked: c.block_busy, onchange: (e) => run(() => api('PUT', '/api/me/calendar', { block_busy: e.target.checked }), 'Guardado') }), 'Mis eventos ocupados bloquean mis horarios'));
      actions.push(h('button', { class: 'small danger', onclick: async () => { if (await confirmAction('¿Desconectar tu calendario? Las citas ya copiadas se quedan en él.')) { if (await run(() => api('DELETE', '/api/me/calendar'), 'Desconectado')) render(); } } }, 'Desconectar'));
    }
  } else if (c.connected && isAdmin()) {
    actions.push(h('button', { class: 'small danger', onclick: async () => { if (await confirmAction(`¿Desconectar el calendario de ${p.name || p.email}?`)) { if (await run(() => api('DELETE', `/api/team/${p.id}/calendar`), 'Desconectado')) render(); } } }, 'Desconectar'));
  } else if (!c.connected) {
    actions.push(h('span', { class: 'small muted' }, 'Cada persona conecta su calendario desde su propia sesión (Agenda → Mi disponibilidad).'));
  }
  return h('div', { class: 'row', style: 'margin:8px 0' }, h('strong', {}, '📆 Calendario:'), line, actions);
}

/** Fecha AAAA-MM-DD en la zona horaria del negocio. */
const tzDate = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const capital = (x) => x.charAt(0).toUpperCase() + x.slice(1);

const dayTitle = (iso) => capital(new Date(iso + 'T12:00:00Z').toLocaleDateString('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }));

/** Partes de una fecha en la hora del negocio: día (AAAA-MM-DD) y minutos desde la medianoche. */
const tzParts = (d, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
};
const monthTitle = (iso) => capital(new Date(iso + 'T12:00:00Z').toLocaleDateString('es-MX', { timeZone: 'UTC', month: 'long', year: 'numeric' }));
const shortMonth = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('es-MX', { timeZone: 'UTC', month: 'short' }).replace('.', '');
const shortDay = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('es-MX', { timeZone: 'UTC', weekday: 'short' }).replace('.', '');
const dayNum = (iso) => Number(iso.slice(8, 10));
/** Colores de las personas (y gris para las citas sin persona). */
const PALETTE = ['#155eef', '#12b76a', '#f79009', '#7a5af8', '#ee46bc', '#06aed4', '#f04438', '#669f2a'];
const VIEWS = [['day', 'Día'], ['week', 'Semana'], ['month', 'Mes']];
const HOUR_PX = 56;

/**
 * Calendario de citas al estilo de Go High Level: vistas de día, semana y mes; citas de color por persona; filtros por
 * servicio y por persona; al hacer clic en una cita se abre su ficha con las acciones.
 */
async function agendaWeek(root, params) {
  const { timezone: tz } = await api('GET', withAcct('/api/agenda/info'));
  state.timeZone = tz;
  const today = tzDate(new Date(), tz);
  const narrow = matchMedia('(max-width: 800px)').matches;
  const view = ['day', 'week', 'month'].includes(params.get('view')) ? params.get('view') : narrow ? 'day' : 'week';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : params.get('week') || today;
  const filter = { svc: params.get('svc') || '', user: params.get('user') || '' };
  const dow = (iso) => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const monday = addDaysIso(anchor, -dow(anchor));
  const monthStart = `${anchor.slice(0, 8)}01`;
  const gridStart = view === 'month' ? addDaysIso(monthStart, -dow(monthStart)) : view === 'week' ? monday : anchor;
  const days = [...Array(view === 'month' ? 42 : view === 'week' ? 7 : 1)].map((_, i) => addDaysIso(gridStart, i));
  // Rango amplio en UTC; luego se agrupa por día en la hora del negocio.
  const from = new Date(days[0] + 'T00:00:00Z').getTime() - 86400000;
  const to = new Date(days.at(-1) + 'T00:00:00Z').getTime() + 2 * 86400000;
  const [appts, services, team] = await Promise.all([
    api('GET', withAcct(`/api/appointments?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`)),
    api('GET', withAcct('/api/services')),
    api('GET', withAcct('/api/team/agenda')).catch(() => []),
  ]);
  const go = (patch) => {
    const q = new URLSearchParams({ view, date: anchor, svc: filter.svc, user: filter.user, ...patch });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    location.hash = `#/agenda/citas?${q}`;
  };
  const step = (n) => go({ date: view === 'month' ? `${addDaysIso(monthStart, n * 31).slice(0, 8)}01` : addDaysIso(anchor, n * (view === 'week' ? 7 : 1)) });
  const hhmm = (d) => new Date(d).toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

  // Color de cada persona (por su orden en el equipo).
  const people = new Map(team.map((p, i) => [p.id, { name: p.name || p.email, color: PALETTE[i % PALETTE.length] }]));
  for (const a of appts) if (a.assigned_user_id && !people.has(a.assigned_user_id)) people.set(a.assigned_user_id, { name: a.assigned_user_name || 'Persona del equipo', color: PALETTE[people.size % PALETTE.length] });
  const colorOf = (a) => people.get(a.assigned_user_id)?.color ?? '#667085';
  const shown = appts.filter((a) => (!filter.svc || a.service_id === filter.svc) && (!filter.user || (filter.user === 'none' ? !a.assigned_user_id : a.assigned_user_id === filter.user)));

  // Nueva cita
  const n = { service_id: services.find((s) => s.active)?.id || '', slot: '', customer_name: '', customer_phone: '', notes: '', assigned_user_id: '' };
  const slotBox = h('div');
  const loadSlots = async () => {
    if (!n.service_id) return fill(slotBox, h('p', { class: 'muted' }, 'Crea un servicio primero.'));
    const slots = await api('GET', `/api/services/${n.service_id}/slots`);
    n.slot = slots[0]?.key || '';
    n.assigned_user_id = '';
    const whoBox = h('div');
    // Quién atiende: «le toca a quien corresponda» o una de las personas libres en ese horario.
    const drawWho = () => {
      const free = slots.find((x) => x.key === n.slot)?.users || [];
      if (!n.assigned_user_id || !free.includes(n.assigned_user_id)) n.assigned_user_id = '';
      fill(whoBox, free.length > 1 && isAdmin() ? field('Atiende', select(n, 'assigned_user_id', [['', 'Automático (según el reparto del servicio)'], ...free.map((u) => [u, people.get(u)?.name || 'Persona del equipo'])])) : null);
    };
    fill(slotBox, slots.length ? [field('Horario disponible', select(n, 'slot', slots.map((x) => [x.key, x.label]), drawWho)), whoBox] : h('p', { class: 'muted' }, 'Sin horarios disponibles.'));
    drawWho();
  };
  const createBox = h('div', { class: 'card', hidden: true },
    h('h2', { style: 'margin-top:0' }, 'Nueva cita o llamada'),
    field('Servicio', select(n, 'service_id', services.filter((s) => s.active).map((s) => [s.id, `${s.name} (${s.kind === 'call' ? 'llamada' : 'cita'})`]), loadSlots)),
    slotBox,
    h('div', { class: 'grid' }, field('Nombre del cliente', text(n, 'customer_name')), field('Teléfono', text(n, 'customer_phone', { placeholder: '5215512345678' }))),
    field('Notas', area(n, 'notes')),
    h('p', { class: 'small muted' }, 'Para avisar al cliente por su chat, agenda desde su conversación.'),
    h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', '/api/appointments', { ...n, assigned_user_id: n.assigned_user_id || null }), 'Agendada ✅')) render(); } }, 'Agendar'));

  const title = view === 'month' ? monthTitle(anchor) : view === 'week'
    ? `${dayNum(days[0])} ${shortMonth(days[0])} – ${dayNum(days[6])} ${shortMonth(days[6])} ${days[6].slice(0, 4)}`
    : dayTitle(anchor);
  const toolbar = h('div', { class: 'cal-toolbar' },
    h('div', { class: 'row' },
      h('button', { onclick: () => go({ date: today }) }, 'Hoy'),
      h('div', { class: 'btn-group' },
        h('button', { class: 'icon-only', 'aria-label': 'Periodo anterior', onclick: () => step(-1) }, '‹'),
        h('button', { class: 'icon-only', 'aria-label': 'Periodo siguiente', onclick: () => step(1) }, '›')),
      h('strong', { class: 'cal-title' }, title)),
    h('div', { class: 'row' },
      h('select', { 'aria-label': 'Servicio', onchange: (e) => go({ svc: e.target.value }) },
        h('option', { value: '' }, 'Todos los servicios'), services.map((s) => h('option', { value: s.id, selected: s.id === filter.svc }, s.name))),
      people.size ? h('select', { 'aria-label': 'Persona', onchange: (e) => go({ user: e.target.value }) },
        h('option', { value: '' }, 'Todo el equipo'), [...people].map(([id, p]) => h('option', { value: id, selected: id === filter.user }, p.name)), h('option', { value: 'none', selected: filter.user === 'none' }, 'Sin asignar')) : null,
      h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Vista' }, VIEWS.map(([k, l]) => h('button', { class: k === view ? 'active' : '', 'aria-pressed': String(k === view), onclick: () => go({ view: k }) }, l))),
      h('button', { class: 'primary', onclick: () => { createBox.hidden = !createBox.hidden; if (!createBox.hidden) loadSlots(); } }, '+ Nueva cita')));

  const event = (a, extra = {}) => h('button', {
    class: `cal-event status-${a.status}${a.source === 'simulador' ? ' test' : ''}`, type: 'button', style: `--ev:${colorOf(a)};${extra.style || ''}`,
    'aria-label': `${hhmm(a.starts_at)}, ${a.service_name}, ${a.customer_name || 'cliente'}${a.status === 'cancelled' ? ' (cancelada)' : ''}`,
    onclick: (e) => { e.stopPropagation(); openAppointment(a); },
  }, h('span', { class: 'cal-event-time' }, hhmm(a.starts_at)), ' ', h('span', { class: 'cal-event-title' }, a.customer_name || 'Cliente'), extra.full ? h('span', { class: 'cal-event-sub' }, a.service_name) : null);

  const byDay = new Map(days.map((d) => [d, []]));
  for (const a of shown) byDay.get(tzParts(a.starts_at, tz).date)?.push(a);
  for (const list of byDay.values()) list.sort((x, y) => new Date(x.starts_at) - new Date(y.starts_at));

  let grid;
  if (view === 'month') {
    grid = h('div', { class: 'cal-month' },
      ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'].map((d) => h('div', { class: 'cal-month-head' }, d)),
      days.map((d) => {
        const list = byDay.get(d);
        return h('div', { class: `cal-month-cell${d.slice(0, 7) === anchor.slice(0, 7) ? '' : ' other'}${d === today ? ' today' : ''}` },
          h('button', { class: 'cal-daynum', 'aria-label': dayTitle(d), onclick: () => go({ view: 'day', date: d }) }, dayNum(d)),
          list.slice(0, 3).map((a) => event(a)),
          list.length > 3 ? h('button', { class: 'cal-more', onclick: () => go({ view: 'day', date: d }) }, `+${list.length - 3} más`) : null);
      }));
  } else {
    // Rejilla de horas: de 7 a 21 h, o más si hay citas fuera de ese rango.
    const mins = shown.filter((a) => byDay.has(tzParts(a.starts_at, tz).date)).flatMap((a) => [tzParts(a.starts_at, tz).minutes, tzParts(a.ends_at, tz).minutes || 1440]);
    const startH = Math.min(7, ...mins.map((m) => Math.floor(m / 60)));
    const endH = Math.max(21, ...mins.map((m) => Math.ceil(m / 60)));
    const hours = [...Array(endH - startH)].map((_, i) => startH + i);
    const top = (m) => ((m - startH * 60) / 60) * HOUR_PX;
    const now = tzParts(new Date(), tz);
    const column = (d) => {
      const list = byDay.get(d);
      // Citas que se enciman: se reparten en carriles lado a lado.
      const lanes = [];
      const placed = list.map((a) => {
        const s = tzParts(a.starts_at, tz).minutes;
        const endParts = tzParts(a.ends_at, tz);
        const e = Math.max(s + 20, endParts.date === d ? endParts.minutes : 1440);
        let lane = lanes.findIndex((end) => end <= s);
        if (lane < 0) { lane = lanes.length; lanes.push(e); } else lanes[lane] = e;
        return { a, s, e, lane };
      });
      const width = 100 / Math.max(1, lanes.length);
      return h('div', { class: `cal-col${d === today ? ' today' : ''}`, style: `height:${hours.length * HOUR_PX}px` },
        d === today && now.minutes >= startH * 60 && now.minutes <= endH * 60 ? h('div', { class: 'cal-now', style: `top:${top(now.minutes)}px` }) : null,
        placed.map(({ a, s, e, lane }) => event(a, { full: true, style: `top:${top(s)}px;height:${Math.max(22, top(e) - top(s) - 2)}px;left:calc(${lane * width}% + 2px);width:calc(${width}% - 4px)` })));
    };
    grid = h('div', { class: `cal-grid cal-${view}`, style: `--cols:${days.length};--hour:${HOUR_PX}px` },
      h('div', { class: 'cal-head' }, h('div', { class: 'cal-gutter' }),
        days.map((d) => h('button', { class: `cal-dayhead${d === today ? ' today' : ''}`, 'aria-label': dayTitle(d), onclick: () => go({ view: 'day', date: d }) }, h('span', {}, shortDay(d)), h('strong', {}, dayNum(d))))),
      h('div', { class: 'cal-body', tabindex: '0', role: 'region', 'aria-label': 'Horas del calendario' },
        h('div', { class: 'cal-gutter' }, hours.map((hh) => h('div', { class: 'cal-hour', style: `height:${HOUR_PX}px` }, `${String(hh).padStart(2, '0')}:00`))),
        days.map(column)));
  }
  const legend = people.size ? h('div', { class: 'cal-legend' }, [...people].map(([, p]) => h('span', {}, h('i', { style: `background:${p.color}` }), p.name)), h('span', {}, h('i', { style: 'background:#667085' }), 'Sin asignar')) : null;
  root.append(createBox, h('div', { class: 'card cal-card' }, toolbar, grid, legend,
    h('p', { class: 'small muted', style: 'margin:8px 0 0' }, `Hora de ${tz} · ${shown.length} ${shown.length === 1 ? 'cita' : 'citas'} en este periodo`)));
  // En la semana y el día, la vista empieza en la mañana.
  const body = grid.querySelector('.cal-body');
  if (body) requestAnimationFrame(() => { body.scrollTop = HOUR_PX - 12; });

  /** Ficha de la cita (como el panel de cita de GHL): datos y acciones. */
  function openAppointment(a) {
    const [cls, label] = APPT_STATUS[a.status];
    const previous = document.activeElement;
    const box = h('dialog', { class: 'card app-dialog appt-panel', 'aria-label': `Cita de ${a.customer_name || 'cliente'}` });
    const close = () => { box.close(); box.remove(); if (previous?.isConnected) previous.focus(); };
    const act = (text, fn, cls2 = '') => h('button', { class: cls2, onclick: async () => { const r = await fn(); if (r) { close(); render(); } } }, text);
    box.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    box.append(
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, a.kind === 'call' ? '📞 ' : '📅 ', a.service_name), h('button', { class: 'icon-only', 'aria-label': 'Cerrar', onclick: close }, '✕')),
      h('p', {}, h('span', { class: `badge ${cls}` }, label), a.source === 'simulador' ? h('span', { class: 'badge' }, ' prueba') : null),
      h('dl', { class: 'appt-facts' },
        h('dt', {}, 'Cuándo'), h('dd', {}, `${dayTitle(tzParts(a.starts_at, tz).date)}, ${hhmm(a.starts_at)}–${hhmm(a.ends_at)}`),
        h('dt', {}, 'Cliente'), h('dd', {}, a.customer_name || 'Cliente', a.customer_phone ? ` · +${a.customer_phone.replace(/^\+/, '')}` : '', a.customer_email ? ` · ${a.customer_email}` : ''),
        h('dt', {}, 'Atiende'), h('dd', {}, h('i', { class: 'dot', style: `background:${colorOf(a)}` }), ' ', a.assigned_user_name || 'Sin asignar'),
        a.meeting_url ? [h('dt', {}, 'Videollamada'), h('dd', {}, h('a', { href: a.meeting_url, target: '_blank', rel: 'noopener' }, 'Entrar a la videollamada'))] : null,
        a.source === 'pagina' ? [h('dt', {}, 'Origen'), h('dd', {}, 'Reservó en tu página para agendar')] : null,
        a.notes ? [h('dt', {}, 'Notas'), h('dd', {}, a.notes)] : null,
        a.cancel_reason ? [h('dt', {}, 'Motivo'), h('dd', {}, a.cancel_reason)] : null),
      h('div', { class: 'row' },
        a.conversation_id ? h('a', { class: 'btn', href: `#/conversation/${a.conversation_id}`, onclick: close }, 'Abrir chat') : null,
        a.status === 'confirmed' ? act('Completada', () => run(() => api('PUT', `/api/appointments/${a.id}`, { status: 'completed' }), 'Listo')) : null,
        a.status === 'confirmed' ? act('No asistió', () => run(() => api('PUT', `/api/appointments/${a.id}`, { status: 'no_show' }), 'Listo')) : null,
        a.status === 'confirmed' ? act('Reprogramar', async () => {
          const slots = a.service_id ? await api('GET', `/api/services/${a.service_id}/slots`) : [];
          if (!slots.length) return run(() => { throw new Error('No hay horarios disponibles para este servicio.'); });
          const choice = { slot: slots[0].key };
          if (!(await dialog('Reprogramar cita', field('Nuevo horario disponible', select(choice, 'slot', slots.map((slot) => [slot.key, slot.label]))), 'Reprogramar y avisar al cliente'))) return null;
          return run(() => api('PUT', `/api/appointments/${a.id}`, { slot: choice.slot.trim() }), 'Reprogramada');
        }) : null,
        a.status === 'confirmed' ? act('Cancelar cita', async () => {
          const reason = await ask('Motivo de la cancelación (se avisará al cliente si tiene chat)', 'Cancelada por el negocio');
          return reason !== null ? run(() => api('POST', `/api/appointments/${a.id}/cancel`, { reason }), 'Cancelada') : null;
        }, 'danger') : null));
    document.body.append(box);
    box.showModal();
  }
}

async function listServices(root) {
  const services = await api('GET', withAcct('/api/services'));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Los servicios son lo que se puede agendar (citas presenciales o llamadas). El bot ofrece solo horarios realmente libres, agenda cuando el cliente elige, envía recordatorios y avisa a quien atiende.'),
      h('a', { class: 'btn primary', href: '#/agenda/servicios?id=new' }, '+ Nuevo servicio')),
    h('div', { class: 'card' }, services.length
      ? h('table', {}, h('tbody', {}, services.map((s) => h('tr', { class: 'click', onclick: () => (location.hash = `#/agenda/servicios?id=${s.id}`) },
          h('td', {}, s.kind === 'call' ? '📞 ' : '📅 ', h('strong', {}, s.name), s.active ? null : h('span', { class: 'badge orange' }, ' inactivo')),
          h('td', { class: 'small' }, `${s.duration_minutes} min`, s.capacity > 1 ? ` · ${s.capacity} a la vez${s.assigned_user_ids.length ? ' por persona' : ''}` : ''),
          h('td', { class: 'small' }, s.assigned_user_ids.length ? `${s.assigned_user_ids.length} ${s.assigned_user_ids.length === 1 ? 'persona' : 'personas'}${s.assigned_user_ids.length > 1 ? ` · ${s.assignment_mode === 'weighted' ? 'por porcentajes' : 'por turnos'}` : ''}${s.prefer_owner ? ' · primero quien atiende' : ''}${s.customer_choice ? ' · el cliente elige' : ''}` : 'Sin personas asignadas', s.kind === 'call' ? ` · ${s.call_mode === 'video' ? '📹 videollamada' : '📞 telefónica'}` : ''),
          h('td', { class: 'small muted' }, s.hours ? 'horario propio' : 'horario del negocio')))))
      : h('p', { class: 'muted' }, 'Aún no hay servicios.')),
  );
}

async function editService(root, id) {
  const [services, users] = await Promise.all([api('GET', withAcct('/api/services')), api('GET', withAcct('/api/users'))]);
  const existing = id === 'new' ? null : services.find((s) => s.id === id);
  if (id !== 'new' && !existing) throw new Error('Servicio no encontrado');
  const s = draftModel(`service:${id}`, existing || { name: '', kind: 'appointment', description: '', duration_minutes: 30, buffer_minutes: 0, capacity: 1, min_notice_minutes: 60, max_days_ahead: 30, location: '', hours: null, reminders: [1440, 60], reminder_message: '', assigned_user_ids: [], assignment_mode: 'round_robin', user_weights: {}, call_mode: 'phone', prefer_owner: false, customer_choice: false, notify_team: true, active: true }, false);
  s.assignment_mode ||= 'round_robin';
  s.user_weights ||= {};
  s.call_mode ||= 'phone';
  s.prefer_owner ??= false;
  s.customer_choice ??= false;
  // Tipo de llamada: solo en servicios de llamada.
  const callBox = h('div');
  const drawCall = () => fill(callBox, s.kind === 'call'
    ? field('Cómo es la llamada', select(s, 'call_mode', [['phone', 'Telefónica: la persona le marca al cliente'], ['video', 'Videollamada: se le envía un enlace (Meet, Teams o el de la persona)']]),
      s.call_mode === 'video'
        ? 'Con el calendario de la persona conectado (Google u Outlook) se crea una sala para cada llamada; si no, se usa su enlace fijo (Agenda → Equipo). El enlace le llega al cliente al agendar y en los recordatorios.'
        : 'El agente pide el teléfono del cliente si no escribe por WhatsApp; a la persona le llega con quién y a qué número marcar.')
    : null);
  drawCall();
  const own = draftModel(`service-hours:${id}`, { on: !!s.hours }, false);
  const hoursBox = h('div');
  const drawHours = () => fill(hoursBox, own.on ? hoursEditor((s.hours ||= { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [], sun: [] })) : null);
  drawHours();
  const rem = draftModel(`reminders:${id}`, { text: (s.reminders || []).map((n) => n % 1440 === 0 ? `${n / 1440} días` : n % 60 === 0 ? `${n / 60} horas` : `${n} minutos`).join('\n') }, false);
  root.append(draftNotice([`service:${id}`, `reminders:${id}`, `service-hours:${id}`], render));
  const team = users.filter((u) => u.account_id);
  const peopleBox = h('div');
  const drawPeople = () => {
    const chosen = team.filter((u) => s.assigned_user_ids.includes(u.id));
    const total = chosen.reduce((sum, u) => sum + (Number(s.user_weights[u.id] ?? (100 / chosen.length)) || 0), 0);
    fill(peopleBox,
      h('div', { class: 'row' }, team.map((u) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: s.assigned_user_ids.includes(u.id), onchange: (e) => { s.assigned_user_ids = e.target.checked ? [...s.assigned_user_ids, u.id] : s.assigned_user_ids.filter((x) => x !== u.id); drawPeople(); } }),
        u.name || u.email))),
      chosen.length > 1 ? field('Cómo se reparten las citas', select(s, 'assignment_mode', [['round_robin', 'Por turnos (round robin): a cada quien le toca en orden'], ['weighted', 'Por porcentajes: a cada quien su parte']], drawPeople)) : null,
      chosen.length ? h('div', { class: 'stack', style: 'margin:6px 0' },
        check(s, 'prefer_owner', 'Primero con quien ya atiende al cliente (si la conversación tiene una persona asignada y está libre)'),
        check(s, 'customer_choice', 'El cliente puede pedir con quién (el agente le ofrece los horarios de esa persona)')) : null,
      chosen.length > 1 && s.assignment_mode === 'weighted' ? h('div', {},
        h('div', { class: 'row' }, chosen.map((u) => field(`${u.name || u.email} (%)`, h('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round(s.user_weights[u.id] ?? 100 / chosen.length), oninput: (e) => { s.user_weights = { ...s.user_weights, [u.id]: Number(e.target.value) || 0 }; } })))),
        h('p', { class: 'small muted' }, `Suma actual: ${Math.round(total)} %. Se reparte en proporción (no hace falta que sume 100). Con 0 % la persona solo recibe citas cuando nadie más está libre. Si a quien le toca no está libre en ese horario, se le asigna a otra persona.`)) : null);
  };
  drawPeople();
  const save = async () => {
    const reminders = [];
    for (const line of rem.text.split('\n').filter((x) => x.trim())) {
      const match = line.trim().match(/^(\d+(?:\.\d+)?)\s*(minutos?|min|horas?|h|días?|dias?|d)?$/i);
      if (!match) return run(() => { throw new Error('Escribe recordatorios como 1 día, 2 horas o 30 minutos.'); });
      const unit = (match[2] || 'min').toLowerCase();
      const n = Number(match[1]) * (/^(d|día|dia)/.test(unit) ? 1440 : /^(h|hora)/.test(unit) ? 60 : 1);
      if (!Number.isInteger(n) || n <= 0) return run(() => { throw new Error('El recordatorio debe equivaler a minutos completos y ser mayor que cero.'); });
      reminders.push(n);
    }
    const user_weights = Object.fromEntries(Object.entries(s.user_weights || {}).filter(([u]) => s.assigned_user_ids.includes(u)));
    const body = { ...s, user_weights, hours: own.on ? s.hours : null, reminders, account_id: state.accountId || undefined };
    const versions = [`service:${id}`, `reminders:${id}`, `service-hours:${id}`].map((key) => [key, draftVersion(key)]);
    if (await run(() => (existing ? api('PUT', `/api/services/${id}`, body) : api('POST', '/api/services', body)), 'Servicio guardado ✅')) { versions.forEach(([key, version]) => discardDraft(key, version)); location.hash = '#/agenda/servicios'; }
  };
  root.append(
    h('a', { href: '#/agenda/servicios' }, '← Servicios'),
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre', text(s, 'name', { placeholder: 'Consulta inicial' })),
        field('Tipo', select(s, 'kind', [['appointment', 'Cita'], ['call', 'Llamada']], drawCall)),
        field('Duración (min)', num(s, 'duration_minutes', { min: 5 })),
        field('Descanso entre citas (min)', num(s, 'buffer_minutes', { min: 0 })),
        field('Citas al mismo tiempo', num(s, 'capacity', { min: 1 }), 'Con personas asignadas: cuántos clientes atiende cada persona a la misma hora (1 = uno a la vez; más para clases o grupos). Sin personas: cuántas citas caben en total.'),
        field('Anticipación mínima (min)', num(s, 'min_notice_minutes', { min: 0 })),
        field('Agendar hasta (días)', num(s, 'max_days_ahead', { min: 1 }))),
      callBox,
      field('Descripción (para que el bot la explique)', area(s, 'description')),
      field('Lugar o indicaciones', text(s, 'location', { placeholder: 'Av. Reforma 123, piso 2 · o · Te llamamos a tu número' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: own.on, onchange: (e) => { own.on = e.target.checked; drawHours(); } }), 'Usar un horario distinto al del negocio'),
      hoursBox,
      check(s, 'active', 'Activo (el bot puede agendarlo)')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Quién atiende y avisos'),
      h('p', { class: 'small muted' }, 'Si eliges personas, solo se ofrecen horarios en los que al menos una esté libre (según su horario, sus días libres y su calendario) y la cita se le asigna a quien le toque. El horario de cada persona se configura en ', h('a', { href: '#/agenda/equipo' }, 'Equipo y disponibilidad'), '.'),
      peopleBox,
      check(s, 'notify_team', 'Avisar al equipo cuando se agenda o cancela'),
      field('Recordatorios antes de la cita', h('textarea', { value: rem.text, oninput: (e) => (rem.text = e.target.value) }), 'Ej.: 1 día, 2 horas o 30 minutos. Uno por renglón. También acepta minutos sin unidad.'),
      field('Mensaje del recordatorio (opcional)', area(s, 'reminder_message', { placeholder: 'Hola {{nombre}}, te recordamos tu {{cita.tipo}} de {{cita.servicio}} el {{cita.fecha}} a las {{cita.hora}}.' }), VARS_HELP)),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (await confirmAction('¿Eliminar el servicio? Las citas existentes se conservan.')) { if (!(await run(() => api('DELETE', `/api/services/${id}`), 'Eliminado'))) return; location.hash = '#/agenda/servicios'; } } }, 'Eliminar')) : null),
  );
}
