import { varsField } from './vars-help.js';
import { api, area, check, confirmAction, dialog, field, fill, fmtDate, h, run, settingsSection, state, text, toast } from './core.js';
import { isAdmin, withAcct } from './session.js';
import { waTemplateField } from './wa-template-field.js';

/* ------------------------------ Cobros: lo que deben tus clientes y sus recordatorios de pago ------------------------------ */

const money = (cents, currency = 'MXN') => {
  try { return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(cents / 100); } catch { return `$${(cents / 100).toFixed(2)} ${currency}`; }
};
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
const STATUS = { pending: 'Pendiente', paid: 'Pagado', canceled: 'Cancelado' };
const parseDays = (s) => {
  const days = String(s).split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  return days.length && days.every((d) => Number.isInteger(d) && d >= -60 && d <= 120) ? days : undefined;
};
const daysText = (days) => (days || []).map((d) => (d < 0 ? `${-d} día${d === -1 ? '' : 's'} antes` : d === 0 ? 'el día' : `${d} día${d === 1 ? '' : 's'} después`)).join(', ');
const SOURCE = { recurring: 'Pago recurrente', appointment: 'Anticipo de cita', quote: 'De una cotización', api: 'Registrado por la API' };
const FREQ = { weekly: 'Cada semana', biweekly: 'Cada 2 semanas', monthly: 'Cada mes' };
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export async function viewReceivables(root, params) {
  const tab = params.get('tab') === 'ajustes' && isAdmin() ? 'ajustes' : params.get('tab') === 'recurrentes' ? 'recurrentes' : 'lista';
  root.append(
    h('h1', {}, 'Cobros'),
    h('p', { class: 'help', style: 'margin:0 0 16px;max-width:760px' }, 'Registra lo que te deben y el asistente lo recuerda por WhatsApp antes y después de la fecha. Te pagan directo con tus instrucciones; tú lo marcas como pagado.'),
    // Las secciones como pestañas subrayadas, igual que en el resto del panel.
    h('nav', { class: 'tabs', 'aria-label': 'Secciones de cobros' },
      h('a', { class: tab === 'lista' ? 'active' : '', href: '#/cobros', 'aria-current': tab === 'lista' ? 'page' : null }, 'Cobros'),
      h('a', { class: tab === 'recurrentes' ? 'active' : '', href: '#/cobros?tab=recurrentes', 'aria-current': tab === 'recurrentes' ? 'page' : null }, 'Recurrentes'),
      isAdmin() ? h('a', { class: tab === 'ajustes' ? 'active' : '', href: '#/cobros?tab=ajustes', 'aria-current': tab === 'ajustes' ? 'page' : null }, 'Ajustes de cobro') : null),
  );
  if (tab === 'ajustes') return settingsView(root);
  if (tab === 'recurrentes') return plansView(root, params);
  return listView(root, params);
}

async function listView(root, params) {
  const f = { status: params.get('status') ?? 'pending', search: '', contact_id: params.get('contact') || '' };
  const body = h('div');
  const load = async () => {
    const q = new URLSearchParams({ status: f.status === 'all' ? '' : f.status });
    if (f.search) q.set('search', f.search);
    if (f.contact_id) q.set('contact_id', f.contact_id);
    const r = await api('GET', withAcct(`/api/receivables?${q}`));
    fill(body, totalsBlock(r.totals), table(r, load));
  };
  let timer;
  root.append(
    newForm(params, load),
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px;margin:12px 0' },
      field('Mostrar', h('select', { onchange: (e) => { f.status = e.target.value; load(); } },
        [['pending', 'Pendientes'], ['overdue', 'Vencidos'], ['paid', 'Pagados'], ['canceled', 'Cancelados'], ['all', 'Todos']].map(([v, l]) => h('option', { value: v, selected: f.status === v }, l)))),
      field('Buscar', h('input', { type: 'search', placeholder: 'Cliente, concepto o referencia', oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { f.search = e.target.value.trim(); load(); }, 300); } })),
      f.contact_id ? h('a', { class: 'btn', href: '#/cobros' }, 'Ver los de todos los clientes') : null),
    body,
  );
  await load();
}

function totalsBlock(totals) {
  if (!totals.length) return null;
  const sum = (k) => totals.map((t) => money(t[k], t.currency)).join(' · ');
  // Una franja dividida: la etiqueta arriba y la cifra debajo; lo vencido en rojo solo cuando hay algo vencido.
  const overdue = totals.some((t) => t.overdue_cents > 0);
  return h('div', { class: 'card kpi-card' }, h('div', { class: 'kpi-strip' },
    h('div', {}, h('span', { class: 'label' }, 'Por cobrar'), h('span', { class: 'value' }, sum('pending_cents'))),
    h('div', {}, h('span', { class: 'label' }, 'Vencido'), h('span', { class: `value${overdue ? ' alert' : ''}` }, sum('overdue_cents'))),
    h('div', {}, h('span', { class: 'label' }, 'Cobrado este mes'), h('span', { class: 'value' }, sum('paid_month_cents')))));
}

function table(r, reload) {
  if (!r.data.length) return h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No hay cobros con este filtro.'));
  const act = (label, fn, cls = '', name = '') => h('button', { class: cls, onclick: fn, 'aria-label': name ? `${label}: ${name}` : null }, label);
  return h('div', { class: 'card', style: 'overflow-x:auto' }, h('table', {},
    h('caption', { class: 'sr-only' }, 'Cobros'),
    h('thead', {}, h('tr', {}, h('th', {}, 'Cliente'), h('th', {}, 'Concepto'), h('th', { class: 'num' }, 'Monto'), h('th', {}, 'Vence'), h('th', {}, 'Estado'), h('th', {}, 'Recordatorios'), h('th', {}, h('span', { class: 'sr-only' }, 'Acciones')))),
    h('tbody', {}, r.data.map((x) => {
      const overdue = x.status === 'pending' && x.due_date < r.today;
      const who = x.contact_name || (x.contact_phone ? `+${x.contact_phone}` : 'Cliente');
      return h('tr', {},
        h('td', {}, x.conversation_id ? h('a', { href: `#/conversation/${x.conversation_id}` }, who) : who),
        h('td', {}, x.concept, x.installment && !x.concept.includes(x.installment) ? ` (${x.installment})` : '',
          x.reference ? h('div', { class: 'small muted' }, `Ref. ${x.reference}`) : null,
          SOURCE[x.source] ? h('div', { class: 'small muted' }, SOURCE[x.source]) : null),
        h('td', { class: 'num' }, money(x.amount_cents, x.currency)),
        h('td', {}, day(x.due_date)),
        h('td', {}, h('span', { class: `badge${overdue ? ' danger' : x.status === 'paid' ? ' ok' : ''}` }, overdue ? 'Vencido' : STATUS[x.status]),
          x.paused_until && new Date(x.paused_until) > new Date() ? h('div', { class: 'small' }, 'Dice que ya pagó: verifícalo') : null,
          x.status === 'paid' && x.paid_at ? h('div', { class: 'small muted' }, fmtDate(x.paid_at)) : null),
        h('td', { class: 'small' }, `${x.reminders_sent} enviado${x.reminders_sent === 1 ? '' : 's'}`, x.last_reminded_at ? h('div', { class: 'muted' }, `último: ${fmtDate(x.last_reminded_at)}`) : null),
        h('td', {}, x.status === 'pending' ? h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
          act('Marcar pagado', async () => {
            const note = h('input', { placeholder: 'Opcional: cómo pagó, folio de la transferencia…' });
            if (!(await dialog(`¿Marcar «${x.concept}» como pagado?`, field('Nota', note), 'Marcar pagado'))) return;
            if (await run(() => api('POST', `/api/receivables/${x.id}/paid`, { note: note.value }), 'Cobro marcado como pagado')) reload();
          }, 'small', x.concept),
          act('Recordar ahora', async () => { if (await run(() => api('POST', `/api/receivables/${x.id}/remind`), 'Recordatorio enviado')) reload(); }, 'small ghost', x.concept),
          act('Editar', () => editDialog(x, reload), 'small ghost', x.concept),
          act('Cancelar', async () => {
            if (!(await confirmAction(`¿Cancelar el cobro «${x.concept}»? Ya no se le recordará al cliente.`))) return;
            if (await run(() => api('POST', `/api/receivables/${x.id}/cancel`), 'Cobro cancelado')) reload();
          }, 'small ghost danger', x.concept)) : null));
    }))));
}

/** Campos de un cobro (nuevo o al editar). `m.reminders`: null = los de la cuenta; undefined = días propios inválidos. */
function receivableFields(m) {
  const custom = { on: !!m.reminders, text: (m.reminders || []).join(', ') };
  const daysBox = h('div');
  const drawDays = () => fill(daysBox, custom.on ? field('Días de recordatorio', text(custom, 'text', { placeholder: '-3, 0, 3, 7', oninput: () => { m.reminders = parseDays(custom.text); } }), 'Negativo = antes del vencimiento, 0 = el día, positivo = después. Separados por comas.') : null);
  drawDays();
  return [
    h('div', { class: 'grid' },
      field('Concepto', text(m, 'concept', { maxlength: 200, required: true, placeholder: 'Mensualidad de octubre' })),
      field('Monto', h('input', { type: 'number', min: 0.01, step: 0.01, required: true, value: m.amount_cents ? m.amount_cents / 100 : '', oninput: (e) => { m.amount_cents = Math.round(Number(e.target.value) * 100); } })),
      field('Vence', h('input', { type: 'date', required: true, value: m.due_date || '', oninput: (e) => { m.due_date = e.target.value; } }))),
    h('div', { class: 'grid' },
      field('Enlace de pago (opcional)', text(m, 'payment_link', { type: 'url', placeholder: 'https://mpago.la/…' }), 'Si lo dejas vacío, el recordatorio lleva tus instrucciones de pago.'),
      field('Referencia (opcional)', text(m, 'reference', { maxlength: 100, placeholder: 'Folio o número de cliente' }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: custom.on, onchange: (e) => { custom.on = e.target.checked; m.reminders = custom.on ? parseDays(custom.text) : null; drawDays(); } }), 'Usar días de recordatorio propios para este cobro'),
    daysBox,
  ];
}

const validate = (m) => {
  if (!m.concept?.trim()) return 'Escribe el concepto';
  if (!(m.amount_cents > 0)) return 'Escribe el monto';
  if (!m.due_date) return 'Elige la fecha de vencimiento';
  if (m.reminders === undefined) return 'Revisa los días de recordatorio: números enteros separados por comas';
  return '';
};

/** Buscador de cliente (los que ya te escribieron): deja el elegido en `m.contact_id`. */
function contactPicker(m, pickedName = '') {
  const results = h('div');
  const picked = h('p', { class: 'small', role: 'status' }, pickedName ? `Cliente: ${pickedName}` : '');
  let timer;
  const search = h('input', { type: 'search', placeholder: 'Nombre o teléfono', value: pickedName, oninput: (e) => {
    clearTimeout(timer);
    m.contact_id = '';
    const q = e.target.value.trim();
    timer = setTimeout(async () => {
      if (q.length < 2) return fill(results);
      const r = await api('GET', withAcct(`/api/contacts?search=${encodeURIComponent(q)}`)).catch(() => ({ items: [] }));
      fill(results, r.items.length ? h('ul', { class: 'pick-list', style: 'list-style:none;padding:0;margin:4px 0' }, r.items.slice(0, 8).map((c) => h('li', {}, h('button', { type: 'button', onclick: () => {
        m.contact_id = c.id; search.value = c.name; picked.textContent = `Cliente: ${c.name}${c.phone ? ` (+${c.phone})` : ''}`; fill(results);
      } }, `${c.name}${c.phone ? ` · +${c.phone}` : ''}`)))) : h('p', { class: 'small muted' }, 'Sin coincidencias.'));
    }, 250);
  } });
  return [field('Cliente', search, 'Busca a un cliente que ya te haya escrito.'), results, picked];
}

function newForm(params, reload) {
  const m = { contact_id: params.get('contact') || '', concept: '', amount_cents: 0, due_date: '', payment_link: '', reference: '', reminders: null };
  const box = h('details', { class: 'card', open: params.get('contact') ? true : undefined },
    h('summary', {}, h('strong', {}, 'Nuevo cobro')),
    ...contactPicker(m, params.get('name') || ''),
    ...receivableFields(m),
    h('button', { class: 'primary', onclick: async () => {
      const err = !m.contact_id ? 'Elige al cliente de la lista' : validate(m);
      if (err) return toast(err, true);
      const r = await run(() => api('POST', withAcct('/api/receivables'), { ...m, payment_link: m.payment_link.trim() }));
      if (!r) return;
      toast(r.scheduled ? `Cobro registrado: ${r.scheduled} recordatorio(s) programado(s)` : 'Cobro registrado (sin recordatorios por enviar: revisa la fecha)');
      box.open = false;
      reload();
    } }, 'Registrar cobro'));
  return box;
}

async function editDialog(x, reload) {
  const m = { concept: x.concept, amount_cents: x.amount_cents, due_date: x.due_date, payment_link: x.payment_link, reference: x.reference, reminders: x.reminders };
  const ok = await dialog('Editar cobro', h('div', {}, ...receivableFields(m)), 'Guardar', () => { const e = validate(m); if (e) toast(e, true); return !e; });
  if (!ok) return;
  if (await run(() => api('PUT', `/api/receivables/${x.id}`, m), 'Cobro actualizado')) reload();
}

async function settingsView(root) {
  const [{ settings: s, max_reminders: max }, templates] = await Promise.all([
    api('GET', withAcct('/api/receivables/settings')),
    state.meta?.zernio_enabled ? api('GET', withAcct('/api/wa-templates')).catch(() => []) : [],
  ]);
  const days = { text: s.default_reminders.join(', ') };
  const ph = {
    before: 'Hola {{nombre}}, te recordamos que tu pago de {{pago.concepto}} por {{pago.monto}} vence el {{pago.vencimiento}}.',
    due: 'Hola {{nombre}}, hoy vence tu pago de {{pago.concepto}} por {{pago.monto}}.',
    overdue: 'Hola {{nombre}}, tu pago de {{pago.concepto}} por {{pago.monto}} venció el {{pago.vencimiento}}. Si ya pagaste, envíanos tu comprobante por aquí.',
  };
  const preview = h('p', { class: 'small muted', role: 'status' });
  const showDays = () => { const d = parseDays(days.text); preview.textContent = d ? `Se recuerda: ${daysText(d)}.` : 'Revisa los días: números enteros separados por comas.'; };
  showDays();
  root.append(
    // Cada parte en dos columnas (qué es, a la izquierda; sus controles, a la derecha) y un solo «Guardar» al final.
    settingsSection('Cómo te pagan', 'Lo que el cliente necesita para pagarte: una cuenta, un enlace de pago o ambos.',
      field('Instrucciones de pago', area(s, 'payment_instructions', { rows: 4, placeholder: 'Transferencia a la CLABE 012 180 0012 3456 7890 (Banco, a nombre de…)\nO paga con tarjeta: https://mpago.la/…' }), 'Van en cada recordatorio y el asistente las da si el cliente pregunta cómo pagar.')),
    settingsSection('Cuándo recordar', 'Los días, antes y después del vencimiento, en que el asistente le escribe al cliente.',
      h('div', { class: 'grid' },
        field('Días de recordatorio', text(days, 'text', { placeholder: '-3, 0, 3, 7', oninput: showDays }), `Negativo = antes del vencimiento, 0 = el día, positivo = después. Hasta ${max}.`),
        field('Hora de envío', h('input', { type: 'time', value: s.send_at, oninput: (e) => { s.send_at = e.target.value; } }), 'En la zona horaria de tu negocio.')),
      preview,
      check(s, 'respect_business_hours', 'Si a esa hora estás cerrado, enviarlo cuando abras'),
      check(s, 'notify_team_on_overdue', 'Avisar al equipo cuando un cobro vence sin pagarse')),
    settingsSection('Mensajes', 'Vacíos, se usan los de siempre. Si no traen {{pago.link}}, {{pago.instrucciones}} o {{pago.referencia}}, se agregan al final.',
      varsField('Antes de que venza', area(s, 'message_before', { rows: 3, placeholder: ph.before }), 'payment'),
      varsField('El día que vence', area(s, 'message_due', { rows: 3, placeholder: ph.due }), 'payment'),
      varsField('Después de vencido', area(s, 'message_overdue', { rows: 3, placeholder: ph.overdue }), 'payment'),
      waTemplateField(s, templates)),
    h('div', { class: 'settings-actions' }, h('button', { class: 'primary', onclick: async () => {
      const d = parseDays(days.text);
      if (!d) return toast('Revisa los días de recordatorio', true);
      if (d.length > max) return toast(`Hasta ${max} recordatorios`, true);
      s.default_reminders = d;
      await run(() => api('PUT', withAcct('/api/receivables/settings'), s), 'Ajustes de cobro guardados');
    } }, 'Guardar')),
  );
}

/* ------------------------------ Pagos recurrentes ------------------------------ */

const planWhen = (p) => (p.frequency === 'monthly' ? `${FREQ.monthly}, el día ${p.day}${p.day >= 29 ? ' (o el último del mes)' : ''}` : `${FREQ[p.frequency]}, en ${WEEKDAYS[p.day]}`);

async function plansView(root, params) {
  const body = h('div');
  const load = async () => {
    const r = await api('GET', withAcct('/api/receivable-plans'));
    fill(body, !r.data.length ? h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Aún no hay pagos recurrentes.'))
      : h('div', { class: 'card', style: 'overflow-x:auto' }, h('table', {},
        h('caption', { class: 'sr-only' }, 'Pagos recurrentes'),
        h('thead', {}, h('tr', {}, h('th', {}, 'Cliente'), h('th', {}, 'Concepto'), h('th', { class: 'num' }, 'Monto'), h('th', {}, 'Cuándo'), h('th', {}, 'Próximo cobro'), h('th', {}, 'Estado'), h('th', {}, h('span', { class: 'sr-only' }, 'Acciones')))),
        h('tbody', {}, r.data.map((p) => h('tr', {},
          h('td', {}, p.contact_name || (p.contact_phone ? `+${p.contact_phone}` : 'Cliente')),
          h('td', {}, p.concept),
          h('td', { class: 'num' }, money(p.amount_cents, p.currency)),
          h('td', { class: 'small' }, planWhen(p), p.max_payments ? h('div', { class: 'muted' }, `${p.payments_created} de ${p.max_payments} pagos`) : p.ends_on ? h('div', { class: 'muted' }, `hasta ${day(p.ends_on)}`) : null),
          h('td', {}, p.next_due ? day(p.next_due) : '—'),
          h('td', {}, h('span', { class: `badge${p.active ? ' ok' : ''}` }, p.active ? 'Activo' : p.next_due === null && p.payments_created ? 'Terminado' : 'Pausado')),
          h('td', {}, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
            h('button', { 'aria-label': `${p.active ? 'Pausar' : 'Reanudar'}: ${p.concept}`, onclick: async () => {
              if (await run(() => api('PUT', `/api/receivable-plans/${p.id}`, { active: !p.active }), p.active ? 'Pago recurrente pausado' : 'Pago recurrente reanudado')) load();
            } }, p.active ? 'Pausar' : 'Reanudar'),
            isAdmin() ? h('button', { 'aria-label': `Borrar: ${p.concept}`, onclick: async () => {
              if (!(await confirmAction(`¿Borrar el pago recurrente «${p.concept}»? Los cobros que ya creó se quedan.`))) return;
              if (await run(() => api('DELETE', `/api/receivable-plans/${p.id}`), 'Pago recurrente borrado')) load();
            } }, 'Borrar') : null))))))));
  };
  root.append(
    h('p', { class: 'small muted' }, 'Una mensualidad o cuota fija: unos días antes de cada vencimiento se crea su cobro, con recordatorios. Pausarlo o borrarlo no toca los cobros ya creados.'),
    planForm(params, load),
    body);
  await load();
}

function planForm(params, reload) {
  const today = new Date().toISOString().slice(0, 10);
  const m = { contact_id: params.get('contact') || '', concept: '', amount: '', frequency: 'monthly', day: '1', starts_on: today, ends_on: '', max_payments: '', payment_link: '', reference: '' };
  const dayBox = h('div');
  const drawDay = () => fill(dayBox, m.frequency === 'monthly'
    ? field('Día del mes', h('input', { type: 'number', min: 1, max: 31, value: m.day, oninput: (e) => { m.day = e.target.value; } }), 'Si el mes es más corto, vence el último día.')
    : field('Día de la semana', h('select', { onchange: (e) => { m.day = e.target.value; } }, WEEKDAYS.map((d, i) => h('option', { value: String(i), selected: String(i) === m.day }, d)))));
  drawDay();
  const box = h('details', { class: 'card' },
    h('summary', {}, h('strong', {}, 'Nuevo pago recurrente')),
    ...contactPicker(m, params.get('name') || ''),
    h('div', { class: 'grid' },
      field('Concepto', text(m, 'concept', { maxlength: 200, placeholder: 'Mensualidad del gimnasio' })),
      field('Monto', h('input', { type: 'number', min: 0.01, step: 0.01, oninput: (e) => { m.amount = e.target.value; } })),
      field('Frecuencia', h('select', { onchange: (e) => { m.frequency = e.target.value; m.day = '1'; drawDay(); } },
        Object.entries(FREQ).map(([v, l]) => h('option', { value: v, selected: v === m.frequency }, l)))),
      dayBox),
    h('div', { class: 'grid' },
      field('Empieza', h('input', { type: 'date', value: m.starts_on, oninput: (e) => { m.starts_on = e.target.value; } })),
      field('Termina (opcional)', h('input', { type: 'date', oninput: (e) => { m.ends_on = e.target.value; } })),
      field('Número de pagos (opcional)', h('input', { type: 'number', min: 1, max: 600, oninput: (e) => { m.max_payments = e.target.value; } }), 'Déjalo vacío si no tiene fin.')),
    h('div', { class: 'grid' },
      field('Enlace de pago (opcional)', text(m, 'payment_link', { type: 'url', placeholder: 'https://mpago.la/…' })),
      field('Referencia (opcional)', text(m, 'reference', { maxlength: 100 }))),
    h('button', { class: 'primary', onclick: async () => {
      const amount = Math.round(Number(m.amount) * 100);
      const err = !m.contact_id ? 'Elige al cliente de la lista' : !m.concept.trim() ? 'Escribe el concepto' : !(amount > 0) ? 'Escribe el monto' : !m.starts_on ? 'Elige cuándo empieza' : '';
      if (err) return toast(err, true);
      const r = await run(() => api('POST', withAcct('/api/receivable-plans'), {
        contact_id: m.contact_id, concept: m.concept.trim(), amount_cents: amount, frequency: m.frequency, day: Number(m.day), starts_on: m.starts_on,
        ends_on: m.ends_on || null, max_payments: m.max_payments ? Number(m.max_payments) : null, payment_link: m.payment_link.trim(), reference: m.reference.trim(),
      }));
      if (!r) return;
      toast(r.created ? `Pago recurrente registrado: ya se creó su primer cobro` : `Pago recurrente registrado: el primer cobro se crea unos días antes del ${r.plan.next_due ? day(r.plan.next_due) : 'vencimiento'}`);
      box.open = false;
      reload();
    } }, 'Registrar pago recurrente'));
  return box;
}
