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
    h('div', { class: 'tabs' }, [['citas', 'Citas y llamadas'], ...(isAdmin() ? [['servicios', 'Servicios']] : []), ['equipo', isAdmin() ? 'Equipo y disponibilidad' : 'Mi disponibilidad']].map(([k, l]) => h('a', { href: `#/agenda/${k}`, class: k === tab ? 'active' : '' }, l))),
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
  const m = { own: !!p.hours, hours: p.hours || { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [], sun: [] }, time_off: clone(p.time_off) };
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
  const save = () => run(() => api('PUT', `/api/team/${p.id}/schedule`, { hours: m.own ? m.hours : null, time_off: m.time_off }), 'Disponibilidad guardada ✅');
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, p.name || p.email),
      h('span', { class: 'small muted' }, p.services.length ? `Atiende: ${p.services.map((s) => s.name).join(', ')}` : 'No está asignada a ningún servicio')),
    calendarBox(p, mine),
    h('h3', {}, 'Horario'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.own, onchange: (e) => { m.own = e.target.checked; drawHours(); } }), 'Tiene su propio horario'),
    hoursBox,
    h('h3', {}, 'Días libres'),
    offBox,
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

async function agendaWeek(root, params) {
  const { timezone: tz } = await api('GET', withAcct('/api/agenda/info'));
  state.timeZone = tz;
  const today = tzDate(new Date(), tz);
  const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const monday = params.get('week') || addDaysIso(today, -dow);
  const days = [...Array(7)].map((_, i) => addDaysIso(monday, i));
  // Rango amplio en UTC; luego se agrupa por día en la hora del negocio.
  const from = new Date(monday + 'T00:00:00Z').getTime() - 86400000;
  const to = new Date(days[6] + 'T00:00:00Z').getTime() + 2 * 86400000;
  const [appts, services] = await Promise.all([
    api('GET', withAcct(`/api/appointments?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`)),
    api('GET', withAcct('/api/services')),
  ]);
  const go = (n) => (location.hash = `#/agenda/citas?week=${addDaysIso(monday, n)}`);
  const hhmm = (d) => new Date(d).toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

  // Nueva cita
  const n = { service_id: services.find((s) => s.active)?.id || '', slot: '', customer_name: '', customer_phone: '', notes: '', assigned_user_id: '' };
  const team = isAdmin() ? await api('GET', withAcct('/api/team/agenda')).catch(() => []) : [];
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
      fill(whoBox, free.length > 1 && isAdmin() ? field('Atiende', select(n, 'assigned_user_id', [['', 'A quien le toque (turnos o porcentajes)'], ...free.map((u) => [u, team.find((p) => p.id === u)?.name || 'Persona del equipo'])])) : null);
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

  const byDay = new Map(days.map((d) => [d, []]));
  for (const a of appts) {
    const k = tzDate(a.starts_at, tz);
    if (byDay.has(k)) byDay.get(k).push(a);
  }
  const action = (a, label, fn, cls = 'small') => h('button', { class: cls, onclick: async () => { if (await run(fn, 'Listo')) render(); } }, label);
  root.append(
    h('div', { class: 'card row between' },
      h('div', { class: 'row' }, h('button', { onclick: () => go(-7) }, '← Semana anterior'), h('button', { onclick: () => (location.hash = '#/agenda/citas') }, 'Hoy'), h('button', { onclick: () => go(7) }, 'Semana siguiente →')),
      h('strong', {}, `${dayTitle(days[0])} – ${dayTitle(days[6])}`, h('span', { class: 'small muted' }, ` · hora de ${tz}`)),
      h('button', { class: 'primary', onclick: () => { createBox.hidden = !createBox.hidden; if (!createBox.hidden) loadSlots(); } }, '+ Nueva cita')),
    createBox,
    ...[...byDay].map(([day, list]) => h('div', { class: 'card' },
      h('h2', { style: 'margin:0 0 8px' }, dayTitle(day), day === today ? h('span', { class: 'badge green' }, ' hoy') : null),
      list.length ? h('table', {}, h('tbody', {}, list.map((a) => {
        const [cls, label] = APPT_STATUS[a.status];
        return h('tr', {},
          h('td', { style: 'width:70px' }, h('strong', {}, hhmm(a.starts_at))),
          h('td', {}, a.kind === 'call' ? '📞 ' : '📅 ', h('strong', {}, a.service_name), a.source === 'simulador' ? h('span', { class: 'badge' }, ' prueba') : null,
            h('div', { class: 'small muted' }, [a.customer_name || 'Cliente', a.customer_phone && `+${a.customer_phone.replace(/^\+/, '')}`, a.assigned_user_name && `atiende: ${a.assigned_user_name}`, a.notes].filter(Boolean).join(' · '))),
          h('td', {}, h('span', { class: `badge ${cls}` }, label)),
          h('td', {}, h('div', { class: 'row' },
            a.conversation_id ? h('a', { class: 'btn small', href: `#/conversation/${a.conversation_id}` }, 'Chat') : null,
            a.status === 'confirmed' ? action(a, 'Completada', () => api('PUT', `/api/appointments/${a.id}`, { status: 'completed' })) : null,
            a.status === 'confirmed' ? action(a, 'No asistió', () => api('PUT', `/api/appointments/${a.id}`, { status: 'no_show' })) : null,
            a.status === 'confirmed' ? h('button', { class: 'small', onclick: async () => {
              const slots = a.service_id ? await api('GET', `/api/services/${a.service_id}/slots`) : [];
              if (!slots.length) return run(() => { throw new Error('No hay horarios disponibles para este servicio.'); });
              const choice = { slot: slots[0].key };
              if (!(await dialog('Reprogramar cita', field('Nuevo horario disponible', select(choice, 'slot', slots.map((slot) => [slot.key, slot.label]))), 'Reprogramar y avisar al cliente'))) return;
              const pick = choice.slot;
              if (pick && (await run(() => api('PUT', `/api/appointments/${a.id}`, { slot: pick.trim() }), 'Reprogramada'))) render();
            } }, 'Reprogramar') : null,
            a.status === 'confirmed' ? h('button', { class: 'small danger', onclick: async () => {
              const reason = await ask('Motivo de la cancelación (se avisará al cliente si tiene chat)', 'Cancelada por el negocio');
              if (reason !== null && (await run(() => api('POST', `/api/appointments/${a.id}/cancel`, { reason }), 'Cancelada'))) render();
            } }, 'Cancelar') : null)));
      }))) : h('p', { class: 'muted small', style: 'margin:0' }, 'Sin citas'))),
  );
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
          h('td', { class: 'small' }, s.assigned_user_ids.length ? `${s.assigned_user_ids.length} ${s.assigned_user_ids.length === 1 ? 'persona' : 'personas'}${s.assigned_user_ids.length > 1 ? ` · ${s.assignment_mode === 'weighted' ? 'por porcentajes' : 'por turnos'}` : ''}` : 'Sin personas asignadas'),
          h('td', { class: 'small muted' }, s.hours ? 'horario propio' : 'horario del negocio')))))
      : h('p', { class: 'muted' }, 'Aún no hay servicios.')),
  );
}

async function editService(root, id) {
  const [services, users] = await Promise.all([api('GET', withAcct('/api/services')), api('GET', withAcct('/api/users'))]);
  const existing = id === 'new' ? null : services.find((s) => s.id === id);
  if (id !== 'new' && !existing) throw new Error('Servicio no encontrado');
  const s = draftModel(`service:${id}`, existing || { name: '', kind: 'appointment', description: '', duration_minutes: 30, buffer_minutes: 0, capacity: 1, min_notice_minutes: 60, max_days_ahead: 30, location: '', hours: null, reminders: [1440, 60], reminder_message: '', assigned_user_ids: [], assignment_mode: 'round_robin', user_weights: {}, notify_team: true, active: true }, false);
  s.assignment_mode ||= 'round_robin';
  s.user_weights ||= {};
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
        field('Tipo', select(s, 'kind', [['appointment', 'Cita'], ['call', 'Llamada']])),
        field('Duración (min)', num(s, 'duration_minutes', { min: 5 })),
        field('Descanso entre citas (min)', num(s, 'buffer_minutes', { min: 0 })),
        field('Citas al mismo tiempo', num(s, 'capacity', { min: 1 }), 'Con personas asignadas: cuántos clientes atiende cada persona a la misma hora (1 = uno a la vez; más para clases o grupos). Sin personas: cuántas citas caben en total.'),
        field('Anticipación mínima (min)', num(s, 'min_notice_minutes', { min: 0 })),
        field('Agendar hasta (días)', num(s, 'max_days_ahead', { min: 1 }))),
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
