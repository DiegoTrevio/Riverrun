import { discardDraft, draftModel, draftNotice, draftVersion, initializeDraftDefaults } from './editing.js';
import { needAccount } from './admin.js';
import { messageTester, saveBar } from './bot.js';
import { api, area, check, clone, field, fill, fmtDate, h, dialog, localDateTime, lines, num, run, select, state, text, toast, confirmAction } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';
import { waTemplateField } from './wa-template-field.js';

const AUTO_TABS = [['rules', 'Reglas'], ['sequences', 'Flujos'], ['campaigns', 'Campañas']];

export async function viewAutomation(root, tab, id) {
  // El horario y los avisos viven en Ajustes (su propio título, sin las pestañas de automatización).
  root.append(...(tab === 'settings'
    ? [h('h1', {}, 'Horario y avisos')]
    : [h('h1', {}, 'Automatización'), h('div', { class: 'tabs' }, AUTO_TABS.map(([k, l]) => h('a', { href: `#/automation/${k}`, class: k === tab ? 'active' : '' }, l)))]));
  if (needAccount(root)) return;
  const body = h('div');
  root.append(body);
  if (tab === 'rules') return id ? editRule(body, id) : listRules(body);
  if (tab === 'sequences') return id ? editSequence(body, id) : listSequences(body);
  if (tab === 'campaigns') return id ? editCampaign(body, id) : listCampaigns(body);
  if (tab === 'settings') return editSettings(body);
}

/** Datos de apoyo para los editores: chatbots, imágenes, secuencias, usuarios y servicios de la cuenta. */
async function automationRefs() {
  const [bots, sequences, users, services] = await Promise.all([
    api('GET', withAcct('/api/chatbots')),
    api('GET', withAcct('/api/sequences')),
    api('GET', withAcct('/api/users')),
    api('GET', withAcct('/api/services')),
  ]);
  const [files, pipelines, apps, waTemplates] = await Promise.all([
    api('GET', withAcct('/api/attachments')),
    api('GET', withAcct('/api/pipelines')),
    // Apps conectadas (webhooks) para "Enviar la conversación a tu app"; sin perfil elegido no hay lista.
    api('GET', withAcct('/api/webhook-endpoints')).catch(() => []),
    // Plantillas de WhatsApp oficial (para escribir pasadas las 24 h); sin redes conectadas, ninguna.
    state.meta.zernio_enabled ? api('GET', withAcct('/api/wa-templates')).catch(() => []) : [],
  ]);
  return { bots, sequences, users: users.filter((u) => u.account_id), services, pipelines, apps, images: [], files, imagesLoaded: false, imageRequest: null, waTemplates };
}

/**
 * Opciones de foto: las inactivas se marcan (al enviar se omiten) y una foto ya borrada aparece marcada para poder
 * cambiarla o quitarla (si no, el selector mostraría "Sin imagen" con la foto vieja guardada).
 */
function photoOptions(refs, current) {
  const opts = [['', '— Sin imagen —'], ...refs.images.map((i) => [i.id, `${i.name} (${i.bot})${i.active === false ? ' — inactiva: no se enviará' : ''}`])];
  if (current && !refs.images.some((i) => i.id === current)) opts.push([current, refs.imagesLoaded ? '⚠ Foto borrada: elige otra o quítala' : 'Foto guardada · abre el catálogo para ver su nombre']);
  return opts;
}

const TRIGGERS = {
  message_received: 'El cliente escribe un mensaje',
  new_contact: 'Primer mensaje de un cliente nuevo',
  intent: 'La IA detecta una intención',
  data_captured: 'Se guarda un dato del cliente',
  tag_added: 'Se agrega una etiqueta',
  no_reply: 'El cliente no responde en cierto tiempo',
  handoff: 'La conversación pasa a una persona',
  appointment_booked: 'Se agenda una cita o llamada',
  appointment_cancelled: 'Se cancela una cita o llamada',
  opt_out: 'El cliente se da de baja',
  goal_completed: 'Se cumple el objetivo de la conversación',
  stage_reached: 'El recorrido llega a una etapa',
  agent_off: 'El asistente se desactiva en una conversación',
  pipeline_stage: 'Una solicitud cambia de columna en el pipeline',
  quote_sent: 'Se envía una cotización al cliente',
  quote_pending_approval: 'Una cotización final queda por aprobar',
  quote_rejected: 'El equipo rechaza una cotización',
};

export const ACTIONS = {
  send_message: 'Enviar mensaje o foto',
  alert_team: 'Alertar al equipo',
  send_report: 'Enviar reporte de la conversación',
  assign: 'Asignar a alguien del equipo (por turnos)',
  add_tag: 'Agregar etiqueta',
  remove_tag: 'Quitar etiqueta',
  set_field: 'Guardar un dato',
  handoff: 'Pasar a una persona',
  resume_bot: 'Activar / devolver al asistente',
  pause_bot: 'Pausar al asistente',
  close_conversation: 'Cerrar conversación',
  create_task: 'Crear pendiente o nota',
  start_sequence: 'Iniciar secuencia',
  stop_sequences: 'Detener secuencias',
  send_conversation: 'Enviar la conversación a tu app',
  webhook: 'Enviar a otro sistema (webhook)',
};

/** Qué se envía a la app: el resumen, todos los mensajes o ambos. */
const CONTENT_OPTIONS = [['summary', 'El resumen (con análisis y datos del cliente)'], ['full', 'La conversación completa (todos los mensajes)'], ['both', 'Ambos: resumen y conversación completa']];
const appLabel = (ep) => { try { return ep.description || new URL(ep.url).host; } catch { return ep.description || ep.url; } };
const receivesConversations = (ep) => ep.active && (ep.events.includes('*') || ep.events.includes('conversation.sent'));

const CONDITIONS = {
  channel: 'Canal',
  business_hours: 'Horario del negocio',
  has_tag: 'Etiqueta',
  field: 'Dato del cliente',
  status: 'Estado de la conversación',
  agent: 'Asistente activo o en pausa',
};

function photoPicker(obj, key, refs) {
  const control = select(obj, key, photoOptions(refs, obj[key]));
  control.addEventListener('focus', async () => {
    if (refs.imagesLoaded) return;
    try {
      refs.imageRequest ??= (async () => {
        const result = [];
        for (let i = 0; i < refs.bots.length; i += 3) { const batch = await Promise.all(refs.bots.slice(i, i + 3).map(async (bot) => (await api('GET', `/api/chatbots/${bot.id}/images`)).map((img) => ({ ...img, bot: bot.name })))); result.push(...batch.flat()); }
        refs.images = result; refs.imagesLoaded = true;
      })();
      await refs.imageRequest;
      fill(control, photoOptions(refs, obj[key]).map(([value, label]) => h('option', { value, selected: value === (obj[key] || '') }, label)));
    } catch (error) { refs.imageRequest = null; toast('No pudimos cargar las fotos. Vuelve a abrir el catálogo para reintentar.', true); }
  });
  return control;
}

/** Plantillas para empezar rápido: cubren las necesidades más comunes. */
const RULE_TEMPLATES = [
  { name: 'Bienvenida a clientes nuevos', trigger: { type: 'new_contact' }, actions: [{ type: 'add_tag', tag: 'nuevo' }] },
  { name: 'Fuera de horario', trigger: { type: 'message_received', match: 'any' }, conditions: [{ type: 'business_hours', inside: false }], actions: [{ type: 'send_message', text: 'Gracias por escribir 🙌 Estamos fuera de horario; te respondemos en cuanto abramos.' }] },
  { name: 'Palabra urgente → alerta', trigger: { type: 'message_received', match: 'keywords', keywords: ['urgente', 'emergencia'] }, actions: [{ type: 'alert_team', message: '🚨 {{cliente}} escribió algo urgente: "{{mensaje}}"' }, { type: 'handoff', reason: 'Mensaje urgente' }] },
  { name: 'Seguimiento si no responde', trigger: { type: 'no_reply', minutes: 120 }, conditions: [{ type: 'status', status: 'bot' }], actions: [{ type: 'send_message', text: '¿Pudiste revisarlo, {{nombre}}? Si tienes alguna duda, aquí estoy.' }] },
  { name: 'Queja → persona', trigger: { type: 'intent', intent: 'queja', description: 'El cliente está molesto, inconforme o reporta un problema' }, actions: [{ type: 'handoff', reason: 'Queja del cliente' }, { type: 'alert_team', message: 'Queja de {{cliente}}: "{{mensaje}}"' }] },
  { name: 'Quiere comprar → avisar a ventas', trigger: { type: 'intent', intent: 'listo_para_comprar', description: 'El cliente quiere comprar, reservar o pagar' }, actions: [{ type: 'add_tag', tag: 'caliente' }, { type: 'alert_team', message: '{{cliente}} está listo para comprar. {{link}}' }] },
  { name: 'Correo capturado → CRM', trigger: { type: 'data_captured', field: 'correo' }, actions: [{ type: 'webhook', url: 'https://mi-crm.com/webhook' }] },
  { name: 'Palabra → pausar al asistente', trigger: { type: 'message_received', match: 'keywords', keywords: ['ya no', 'no me interesa'] }, actions: [{ type: 'pause_bot', hours: 0, reason: 'El cliente no quiere seguir' }, { type: 'add_tag', tag: 'no_interesado' }] },
  { name: 'Palabra → activar al asistente', trigger: { type: 'message_received', match: 'keywords', keywords: ['menu', 'hola asistente'] }, actions: [{ type: 'resume_bot' }] },
  { name: 'Palabra → enviar foto', trigger: { type: 'message_received', match: 'keywords', keywords: ['menu', 'catalogo'] }, actions: [{ type: 'send_message', text: '', image_id: '' }] },
  { name: 'Objetivo cumplido → reporte al equipo', trigger: { type: 'goal_completed' }, actions: [{ type: 'send_report', roles: ['admin'], note: 'Objetivo cumplido' }] },
  { name: 'Objetivo cumplido → resumen a mi app', trigger: { type: 'goal_completed' }, actions: [{ type: 'send_conversation', content: 'summary', endpoint_id: '' }] },
  { name: 'Marcada por el equipo → conversación completa a mi app', trigger: { type: 'tag_added', tag: 'enviar-a-mi-app' }, actions: [{ type: 'send_conversation', content: 'full', endpoint_id: '' }] },
  { name: 'Agradecer cita agendada', trigger: { type: 'appointment_booked' }, actions: [{ type: 'send_message', text: 'Te esperamos el {{cita.fecha}} a las {{cita.hora}} 🙌', delay_minutes: 1 }] },
];

export function triggerSummary(t) {
  switch (t.type) {
    case 'message_received':
      return t.match === 'any' ? 'Cualquier mensaje' : `Mensaje ${t.match === 'exact' ? 'igual a' : 'con'}: ${t.keywords.join(', ')}`;
    case 'intent': return `Intención: ${t.intent}`;
    case 'no_reply': return `Sin respuesta en ${t.minutes >= 60 ? `${Math.round(t.minutes / 60 * 10) / 10} h` : `${t.minutes} min`}`;
    case 'data_captured': return `Dato guardado${t.field ? `: ${t.field}` : ''}`;
    case 'tag_added': return `Etiqueta: ${t.tag}`;
    case 'stage_reached': return t.step ? `Llega a la etapa ${t.step}` : 'Llega a cualquier etapa';
    case 'pipeline_stage': return t.stage_id ? `Entra a la columna «${t.stage_id}» del pipeline` : 'Cambia de columna en el pipeline';
    case 'quote_sent': return t.kind === 'final' ? 'Se envía una cotización final' : t.kind === 'approximate' ? 'Se envía una cotización aproximada' : TRIGGERS.quote_sent;
    default: return TRIGGERS[t.type];
  }
}

async function listRules(root) {
  const [rules, bots] = await Promise.all([api('GET', withAcct('/api/automations')), api('GET', withAcct('/api/chatbots'))]);
  const create = async (tpl) => {
    const r = await run(() => api('POST', '/api/automations', { ...tpl, active: false, account_id: state.accountId || undefined }), 'Regla creada (desactivada): revísala y actívala');
    if (r) location.hash = `#/automation/rules/${r.id}`;
  };
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Una regla dice: ', h('strong', {}, 'cuando pase algo'), ', ', h('strong', {}, 'si se cumplen ciertas condiciones'), ', ', h('strong', {}, 'haz estas acciones'), '. Funcionan en todos los canales y junto con la IA.'),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/automation/rules/new' }, '+ Regla en blanco')),
      h('h2', {}, 'Plantillas rápidas'),
      h('div', { class: 'row' }, RULE_TEMPLATES.map((t) => h('button', { class: 'small', onclick: () => create(t) }, t.name)))),
    bots.length ? h('details', { class: 'card' }, h('summary', {}, h('strong', {}, '🧪 Probar palabras'), h('span', { class: 'small muted' }, ' — qué reglas se activan con un mensaje')), messageTester(bots)) : null,
    h('div', { class: 'card' },
      rules.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Regla'), h('th', {}, 'Cuando'), h('th', {}, 'Acciones'), h('th', {}, 'Veces'), h('th', {}, 'Acciones'))),
            h('tbody', {}, rules.map((r) => h('tr', {},
              h('td', {}, h('a', { href: `#/automation/rules/${r.id}` }, h('strong', {}, r.name)), ' ', r.active ? null : h('span', { class: 'badge orange' }, 'inactiva'), r.stop_ai ? h('div', { class: 'small muted' }, 'la IA no responde') : null, r.once_per_conversation ? h('div', { class: 'small muted' }, 'una vez por conversación') : null),
              h('td', { class: 'small' }, triggerSummary(r.trigger), r.conditions.length ? h('div', { class: 'muted' }, `+ ${r.conditions.length} condición(es)`) : null),
              h('td', { class: 'small' }, r.actions.map((a) => ACTIONS[a.type]).join(' → ')),
              h('td', { class: 'small muted' }, r.run_count, r.last_run_at ? h('div', {}, fmtDate(r.last_run_at)) : null),
              h('td', {}, h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/automations/${r.id}`, { active: !r.active }), r.active ? 'Desactivada' : 'Activada')) render(); } }, r.active ? 'Desactivar' : 'Activar'))))))
        : h('p', { class: 'muted' }, 'Aún no hay reglas. Empieza con una plantilla.')),
  );
}

/** Editor de una lista de elementos con tipo (condiciones o acciones). */
function typedList(list, types, fieldsFor, onChange) {
  const box = h('div');
  const draw = () => {
    fill(box,
      ...list.map((item, i) => h('div', { class: 'list-item' },
        h('div', { class: 'row between' },
          h('strong', {}, `${i + 1}. ${types[item.type]}`),
          h('div', { class: 'row' },
            h('button', { class: 'small', disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }, '↑'),
            h('button', { class: 'small danger', onclick: () => { list.splice(i, 1); draw(); onChange?.(); } }, 'Quitar'))),
        fieldsFor(item, draw))),
      h('div', { class: 'row' },
        h('select', { 'aria-label': 'Tipo de condición o acción', onchange: (e) => { if (e.target.value) { list.push({ type: e.target.value }); e.target.value = ''; draw(); onChange?.(); } } },
          h('option', { value: '' }, '+ Agregar…'),
          Object.entries(types).map(([k, l]) => h('option', { value: k }, l)))));
  };
  draw();
  return box;
}

export const VARS_HELP = 'Variables: {{nombre}}, {{cliente}}, {{telefono}}, {{negocio}}, {{mensaje}}, {{link}}, {{dato.CAMPO}}, {{cita.servicio}}, {{cita.fecha}}, {{cita.hora}}, {{cita.lugar}}, {{cita.persona}} (quién atiende), {{cita.enlace}} (enlace de la videollamada)';

const ACCEPT_FILES = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.mp3,.ogg,.wav,.m4a,.mp4,.mov,.webm';
const KIND_LABEL = { document: 'documento', audio: 'audio', video: 'video', image: 'imagen' };

/** Elegir un archivo de la biblioteca o subir uno nuevo (PDF, Word, Excel, audio, video… hasta 16 MB). */
function attachmentPicker(obj, refs) {
  const sel = h('select', { 'aria-label': 'Archivo de la biblioteca', onchange: (e) => { obj.attachment_id = e.target.value; } },
    h('option', { value: '' }, '— Sin archivo —'),
    ...refs.files.map((f) => h('option', { value: f.id }, `${f.name} (${KIND_LABEL[f.kind] || f.kind})`)));
  sel.value = obj.attachment_id || '';
  const up = h('input', { type: 'file', accept: ACCEPT_FILES, onchange: async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    try {
      const created = await api('POST', withAcct('/api/attachments'), body, true);
      refs.files.push(created);
      sel.append(h('option', { value: created.id }, `${created.name} (${KIND_LABEL[created.kind] || created.kind})`));
      sel.value = created.id;
      obj.attachment_id = created.id;
      toast('Archivo subido');
    } catch (err) { toast(err.message, true); }
  } });
  return h('div', {}, sel,
    h('div', { class: 'small muted' }, 'PDF, Word, Excel, PowerPoint, CSV, TXT, audio, video o foto. Máximo 16 MB. Se envía por WhatsApp y correo; los demás canales avisan que no lo admiten.'),
    h('div', { style: 'margin-top:6px' }, up));
}

function actionFields(a, refs) {
  switch (a.type) {
    case 'send_message':
      a.text ??= ''; a.image_id ??= ''; a.attachment_id ??= ''; a.delay_minutes ??= 0;
      return [
        field('Mensaje (opcional si eliges una foto)', area(a, 'text'), VARS_HELP),
        h('div', { class: 'grid' },
          field('Foto (opcional)', photoPicker(a, 'image_id', refs)),
          field('Esperar antes de enviar (minutos)', num(a, 'delay_minutes', { min: 0 }), '0 = de inmediato')),
        field('Archivo (opcional)', attachmentPicker(a, refs)),
        waTemplateField(a, refs.waTemplates),
      ];
    case 'alert_team':
      a.message ??= '{{cliente}} necesita atención: "{{mensaje}}"'; a.roles ??= ['admin', 'agent']; a.user_ids ??= []; a.phones ??= [];
      return [
        field('Mensaje de la alerta', area(a, 'message'), VARS_HELP),
        h('p', { class: 'small muted', style: 'margin:0 0 6px' }, 'Destinatarios (si eliges personas, solo a ellas; si no, por rol):'),
        h('div', { class: 'row' }, refs.users.map((u) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.user_ids.includes(u.id), onchange: (e) => { a.user_ids = e.target.checked ? [...a.user_ids, u.id] : a.user_ids.filter((x) => x !== u.id); } }),
          u.name || u.email, u.notify_whatsapp && u.phone ? ' 📱' : ''))),
        h('div', { class: 'row' }, [['admin', 'Administradores'], ['agent', 'Agentes']].map(([r, l]) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.roles.includes(r), onchange: (e) => { a.roles = e.target.checked ? [...a.roles, r] : a.roles.filter((x) => x !== r); } }), l))),
        check(a, 'round_robin', 'Avisar a una sola persona, por turnos (la siguiente de los destinatarios que esté disponible), en lugar de a todas'),
        field('Además, avisar por WhatsApp a estos números', lines(a, 'phones', { placeholder: '5215512345678' }), '📱 = recibe también por WhatsApp (configurable en Usuarios).'),
      ];
    case 'send_report':
      a.note ??= ''; a.roles ??= ['admin']; a.user_ids ??= []; a.emails ??= []; a.phones ??= []; a.include_transcript ??= false;
      return [
        h('p', { class: 'small muted', style: 'margin:0 0 6px' }, 'Envía el resumen, el análisis y los datos confirmados de la conversación (el resumen se actualiza antes de enviar). Destinatarios (si eliges personas, solo a ellas; si no, por rol):'),
        h('div', { class: 'row' }, refs.users.map((u) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.user_ids.includes(u.id), onchange: (e) => { a.user_ids = e.target.checked ? [...a.user_ids, u.id] : a.user_ids.filter((x) => x !== u.id); } }),
          u.name || u.email, u.notify_whatsapp && u.phone ? ' 📱' : ''))),
        h('div', { class: 'row' }, [['admin', 'Administradores'], ['agent', 'Agentes']].map(([r, l]) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.roles.includes(r), onchange: (e) => { a.roles = e.target.checked ? [...a.roles, r] : a.roles.filter((x) => x !== r); } }), l))),
        field('Además, enviar por correo a', lines(a, 'emails', { placeholder: 'direccion@empresa.com' }), 'Máximo 5. Requiere correo configurado en el servidor.'),
        field('Además, enviar por WhatsApp a', lines(a, 'phones', { placeholder: '5215512345678' })),
        field('Nota (opcional)', text(a, 'note', { placeholder: 'Cliente listo para cotizar' })),
        check(a, 'include_transcript', 'Adjuntar los últimos mensajes'),
      ];
    case 'assign':
      a.message ??= 'Te asignaron a {{cliente}}: "{{mensaje}}"'; a.roles ??= ['agent', 'admin']; a.user_ids ??= []; a.take_over ??= false;
      return [
        field('Aviso para la persona asignada', area(a, 'message'), VARS_HELP),
        h('p', { class: 'small muted', style: 'margin:0 0 6px' }, 'Turno entre (si no eliges personas, entre todas las de estos roles que estén disponibles):'),
        h('div', { class: 'row' }, refs.users.map((u) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.user_ids.includes(u.id), onchange: (e) => { a.user_ids = e.target.checked ? [...a.user_ids, u.id] : a.user_ids.filter((x) => x !== u.id); } }),
          u.name || u.email, u.available === false ? ' (no disponible)' : ''))),
        h('div', { class: 'row' }, [['admin', 'Administradores'], ['agent', 'Agentes']].map(([r, l]) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.roles.includes(r), onchange: (e) => { a.roles = e.target.checked ? [...a.roles, r] : a.roles.filter((x) => x !== r); } }), l))),
        check(a, 'take_over', 'Además, pasar la conversación a una persona (el asistente deja de responder)'),
      ];
    case 'add_tag':
    case 'remove_tag':
      a.tag ??= '';
      return [field('Etiqueta', text(a, 'tag', { placeholder: 'interesado' }))];
    case 'set_field':
      a.field ??= ''; a.value ??= '';
      return [h('div', { class: 'grid' }, field('Clave del dato', text(a, 'field', { placeholder: 'origen' })), field('Valor', text(a, 'value', { placeholder: 'campaña octubre' })))];
    case 'handoff':
      a.reason ??= 'Regla automática';
      return [field('Motivo', text(a, 'reason'))];
    case 'pause_bot':
      a.hours ??= 0; a.reason ??= '';
      return [h('div', { class: 'grid' },
        field('Reactivar solo después de (horas)', num(a, 'hours', { min: 0, max: 720 }), '0 = hasta que lo reactive una palabra, una regla o una persona.'),
        field('Motivo (se ve en la conversación)', text(a, 'reason', { placeholder: 'El cliente pidió que no le escriban' })))];
    case 'create_task':
      a.kind ??= 'pendiente'; a.body ??= ''; a.due_days ??= 0;
      return [
        h('div', { class: 'grid' },
          field('Qué se crea', select(a, 'kind', [['pendiente', 'Pendiente (se puede marcar como hecho)'], ['nota', 'Nota (solo informa)']])),
          field('Vence en (días)', num(a, 'due_days', { min: 0, max: 365 }), '0 = sin fecha límite. Cuenta desde el día en que se dispara la regla.')),
        field('Texto', area(a, 'body', { placeholder: 'Dar seguimiento a {{cliente}}: "{{mensaje}}"' }), VARS_HELP),
      ];
    case 'start_sequence':
      a.sequence_id ??= refs.sequences[0]?.id || '';
      return [refs.sequences.length ? field('Secuencia', select(a, 'sequence_id', refs.sequences.map((s) => [s.id, s.name]))) : h('p', { class: 'muted' }, 'Primero crea una secuencia.')];
    case 'send_conversation': {
      a.content ??= 'summary'; a.endpoint_id ??= '';
      const apps = refs.apps || [];
      const none = a.endpoint_id ? !apps.some((ep) => ep.id === a.endpoint_id && ep.active) : !apps.some(receivesConversations);
      return [
        h('div', { class: 'grid' },
          field('Qué enviar', select(a, 'content', CONTENT_OPTIONS)),
          field('A qué app', select(a, 'endpoint_id', [['', 'Todas las conectadas que reciben conversaciones'], ...apps.map((ep) => [ep.id, `${appLabel(ep)}${ep.active ? '' : ' (apagada)'}`])]))),
        none ? h('p', { class: 'banner warn', style: 'margin:0 0 8px' }, 'Todavía no hay una app conectada que reciba conversaciones. ', h('a', { href: '#/integraciones' }, 'Conéctala en Integraciones'), ' (webhook con el evento «Conversación enviada a tu app»).') : null,
        h('p', { class: 'small muted', style: 'margin:0' }, 'Llega a tu app como el evento conversation.sent, firmado y con reintentos, e incluye qué lo disparó. Tú decides cuándo con el disparador y las condiciones: una etiqueta que pone tu equipo, una intención del cliente, el objetivo cumplido o el paso a una persona. Si incluye el resumen, se actualiza antes de enviar.'),
      ];
    }
    case 'webhook':
      a.url ??= '';
      return [field('URL', text(a, 'url', { placeholder: 'https://hook.n8n.io/…' }), 'Se envía un POST con los datos del cliente, firmado con la cabecera X-Signature (clave en Ajustes → Horario y avisos).')];
    default:
      return [];
  }
}

function conditionFields(c) {
  switch (c.type) {
    case 'channel':
      c.channel_types ??= [];
      return [h('div', { class: 'row' }, state.meta.channel_types.map((t) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: c.channel_types.includes(t.type), onchange: (e) => { c.channel_types = e.target.checked ? [...c.channel_types, t.type] : c.channel_types.filter((x) => x !== t.type); } }), t.label)))];
    case 'business_hours':
      c.inside ??= true;
      return [h('select', { onchange: (e) => (c.inside = e.target.value === 'true') },
        [['true', 'Dentro del horario'], ['false', 'Fuera del horario']].map(([v, l]) => h('option', { value: v, selected: String(c.inside) === v }, l)))];
    case 'has_tag':
      c.tag ??= ''; c.negate ??= false;
      return [h('div', { class: 'grid' }, field('Etiqueta', text(c, 'tag')), check(c, 'negate', 'NO la tiene'))];
    case 'field':
      c.field ??= ''; c.op ??= 'present'; c.value ??= '';
      return [h('div', { class: 'grid' }, field('Dato', text(c, 'field', { placeholder: 'correo' })),
        field('Condición', select(c, 'op', [['present', 'tiene valor'], ['absent', 'está vacío'], ['equals', 'es igual a'], ['contains', 'contiene']])),
        field('Valor', text(c, 'value')))];
    case 'status':
      c.status ??= 'bot';
      return [select(c, 'status', [['bot', 'La atiende el bot'], ['human', 'La atiende una persona'], ['closed', 'Cerrada']])];
    case 'agent':
      c.state ??= 'on';
      return [select(c, 'state', [['on', 'El asistente está activo'], ['off', 'El asistente está en pausa o esperando su palabra']])];
    default:
      return [];
  }
}

async function editRule(root, id) {
  const refs = await automationRefs();
  const existing = id === 'new' ? null : (await api('GET', withAcct('/api/automations'))).find((r) => r.id === id);
  if (id !== 'new' && !existing) throw new Error('Regla no encontrada');
  const r = draftModel(`rule:${id}`, existing || { name: '', active: false, chatbot_id: null, stop_ai: false, once_per_conversation: false, priority: 0, trigger: { type: 'message_received', match: 'keywords', keywords: [] }, conditions: [], actions: [] }, false);
  root.append(draftNotice([`rule:${id}`], render));
  initializeDraftDefaults(`rule:${id}`, () => { r.chatbot_id ??= ''; });
  const trigBox = h('div');
  const drawTrigger = () => {
    const t = r.trigger;
    const f = [];
    if (t.type === 'message_received') {
      t.match ??= 'keywords'; t.keywords ??= []; t.first_message_only ??= false;
      f.push(field('Coincidencia', select(t, 'match', [['keywords', 'Contiene alguna de estas palabras o frases'], ['exact', 'Es exactamente una de ellas'], ['contains', 'Contiene el texto (en cualquier parte)'], ['any', 'Cualquier mensaje']], drawTrigger)));
      if (t.match !== 'any') f.push(field('Palabras o frases', lines(t, 'keywords', { placeholder: 'precio\nlista de precios\ncuánto cuesta' }), 'Una por renglón. No distingue mayúsculas ni acentos.'));
      f.push(check(t, 'first_message_only', 'Solo en el primer mensaje del cliente'));
    } else if (t.type === 'intent') {
      t.intent ??= ''; t.description ??= '';
      f.push(h('div', { class: 'grid' }, field('Identificador', text(t, 'intent', { placeholder: 'quiere_cotizar' })), field('Descripción para la IA', text(t, 'description', { placeholder: 'El cliente pide precio o cotización de un servicio' }))));
    } else if (t.type === 'data_captured') {
      t.field ??= '';
      f.push(field('Dato (vacío = cualquiera)', text(t, 'field', { placeholder: 'correo' })));
    } else if (t.type === 'stage_reached') {
      t.step ??= 0;
      const steps = refs.bots.find((b) => b.id === r.chatbot_id)?.flow?.steps ?? [];
      const n = Math.max(steps.length, 8);
      f.push(field('Etapa del recorrido', h('select', { 'aria-label': 'Tipo de condición o acción', onchange: (e) => { t.step = Number(e.target.value); } },
        [[0, 'Cualquier etapa'], ...Array.from({ length: n }, (_, i) => [i + 1, `Etapa ${i + 1}${steps[i]?.title ? `: ${steps[i].title}` : ''}`])].map(([v, l]) => h('option', { value: v, selected: v === t.step }, l))),
        'Se dispara cuando el asistente marca que la conversación llegó a esa etapa (una vez por cambio de etapa). Elige el asistente en la regla para ver los nombres de sus etapas.'));
    } else if (t.type === 'pipeline_stage') {
      t.pipeline_id ??= ''; t.stage_id ??= '';
      const pipeline = refs.pipelines.find((p) => p.id === t.pipeline_id);
      f.push(h('div', { class: 'grid' },
        field('Pipeline', select(t, 'pipeline_id', [['', 'Cualquiera'], ...refs.pipelines.map((p) => [p.id, p.name])], () => { t.stage_id = ''; drawTrigger(); })),
        field('Columna', select(t, 'stage_id', [['', 'Cualquiera'], ...(pipeline?.stages ?? []).map((s) => [s.id, s.name])]))),
        h('p', { class: 'small muted' }, refs.pipelines.length ? 'Se dispara cada vez que una solicitud entra a esa columna (sola o movida a mano).' : 'Aún no tienes pipelines: créalos en Pipeline.'));
    } else if (t.type === 'tag_added') {
      t.tag ??= '';
      f.push(field('Etiqueta', text(t, 'tag')));
    } else if (t.type === 'no_reply') {
      t.minutes ??= 60;
      f.push(field('Minutos sin respuesta del cliente (después de nuestro último mensaje)', num(t, 'minutes', { min: 1 }), '60 = 1 hora · 1440 = 1 día. Se envía una sola vez por cada silencio.'));
    } else if (t.type === 'quote_sent') {
      t.kind ??= '';
      f.push(field('Tipo de cotización', select(t, 'kind', [['', 'Cualquiera'], ['approximate', 'Aproximada'], ['final', 'Final']])));
    } else if (t.type === 'appointment_booked' || t.type === 'appointment_cancelled') {
      t.service_id ??= '';
      f.push(field('Servicio', select(t, 'service_id', [['', 'Cualquiera'], ...refs.services.map((s) => [s.id, s.name])])));
    }
    fill(trigBox, field('Cuando…', select(r.trigger, 'type', Object.entries(TRIGGERS), (v) => { r.trigger = { type: v }; drawTrigger(); })), ...f);
  };
  initializeDraftDefaults(`rule:${id}`, drawTrigger);
  const save = async () => {
    if (r.actions.some((a) => a.type === 'send_message' && !a.text?.trim() && !a.image_id && !a.attachment_id && !a.wa_template)) return toast('En "Enviar mensaje" escribe un mensaje o elige una foto o un archivo', true);
    const body = { ...r, chatbot_id: r.chatbot_id || null, account_id: state.accountId || undefined };
    const version = draftVersion(`rule:${id}`);
    const saved = await run(() => (existing ? api('PUT', `/api/automations/${id}`, body) : api('POST', '/api/automations', body)), 'Regla guardada ✅');
    if (saved) { discardDraft(`rule:${id}`, version); location.hash = '#/automation/rules'; }
  };
  root.append(
    h('a', { href: '#/automation/rules' }, '← Reglas'),
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre de la regla', text(r, 'name', { placeholder: 'Alerta de quejas' })),
        field('Aplica a', select(r, 'chatbot_id', [['', 'Todos los chatbots de la cuenta'], ...refs.bots.map((b) => [b.id, b.name])], () => { if (r.trigger.type === 'stage_reached') drawTrigger(); }))),
      check(r, 'active', 'Activa'),
      check(r, 'stop_ai', 'Si se cumple, la IA no responde ese mensaje (la regla se encarga)'),
      check(r, 'once_per_conversation', 'Solo una vez por conversación (vuelve a contar si la conversación se reinicia o se reabre)')),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, '1. Cuándo'), trigBox),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, '2. Solo si… (opcional)'), typedList(r.conditions, CONDITIONS, (c) => conditionFields(c))),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, '3. Hacer'), typedList(r.actions, ACTIONS, (a) => actionFields(a, refs))),
    h('details', { class: 'card' }, h('summary', {}, 'Probar la configuración guardada'), h('p', { class: 'help' }, 'La prueba usa las reglas guardadas. Guarda tus cambios antes de probarlos.'), messageTester(refs.bots)),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (await confirmAction('¿Eliminar la regla?')) { if (!(await run(() => api('DELETE', `/api/automations/${id}`), 'Eliminada'))) return; location.hash = '#/automation/rules'; } } }, 'Eliminar')) : null),
  );
}

/* ------------------------------ Secuencias ------------------------------ */

const UNITS = [['minutes', 'minutos'], ['hours', 'horas'], ['days', 'días']];

async function listSequences(root) {
  const seqs = await api('GET', withAcct('/api/sequences'));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Un flujo es una serie de mensajes programados (por ejemplo: hoy, mañana y pasado mañana), con botones si quieres (cada botón hace algo: seguir, terminar, otro flujo, una etiqueta o pasar con una persona). Empieza con una regla, desde una conversación o enviándolo a un grupo de clientes; respeta el horario del negocio y se detiene si el cliente responde.'),
      h('a', { class: 'btn primary', href: '#/automation/sequences/new' }, '+ Nuevo flujo')),
    h('div', { class: 'card' },
      seqs.length
        ? h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Flujo'), h('th', {}, 'Mensajes'), h('th', {}, 'En curso'), h('th', {}, 'Completados'), h('th', {}, 'Detenidos'), h('th', {}, ''))),
            h('tbody', {}, seqs.map((q) => h('tr', { class: 'click', onclick: () => (location.hash = `#/automation/sequences/${q.id}`) },
              h('td', {}, h('strong', {}, q.name), q.active ? null : h('span', { class: 'badge orange' }, ' inactivo'), q.steps.some((st) => st.buttons?.length) ? h('span', { class: 'badge' }, ' con botones') : null),
              h('td', {}, q.steps.length),
              h('td', {}, q.enrollments.active ?? 0), h('td', {}, q.enrollments.completed ?? 0), h('td', {}, q.enrollments.stopped ?? 0),
              h('td', {}, q.active ? h('a', { class: 'btn small', href: `#/automation/campaigns/new?flow=${q.id}`, onclick: (e) => e.stopPropagation() }, 'Enviar a un grupo') : null))))))
        : h('p', { class: 'muted' }, 'Aún no hay flujos.')),
  );
}

const BUTTON_ACTIONS = [['next', 'Seguir con el mensaje siguiente (ya)'], ['end', 'Terminar el flujo'], ['start_sequence', 'Empezar otro flujo'], ['tag', 'Poner una etiqueta'], ['handoff', 'Pasar con una persona']];
const newButton = (kind) => ({ label: '', kind, url: '', action: 'next', sequence_id: null, tag: '', reply: '' });
/** Pasos guardados antes de los botones: se leen con sus valores por omisión. */
const stepDefaults = (st) => { st.buttons ??= []; st.wait_for_choice ??= false; st.if_no_choice ??= 'end'; };

/** Cómo le llega al cliente: con botones (Telegram, Messenger, Instagram, WhatsApp oficial, chat web) o numerado. */
function buttonsPreview(st) {
  const replies = st.buttons.filter((b) => b.kind === 'reply' && b.label.trim());
  const urls = st.buttons.filter((b) => b.kind === 'url' && b.label.trim());
  if (!replies.length && !urls.length) return null;
  const numbered = [st.text.trim(), replies.map((b, i) => `${i + 1}. ${b.label}`).join('\n'), urls.map((b) => `🔗 ${b.label}: ${b.url}`).join('\n'), replies.length ? 'Responde con el número de tu opción.' : ''].filter(Boolean).join('\n\n');
  return h('div', { class: 'grid' },
    h('div', {}, h('div', { class: 'small muted' }, 'Con botones (Telegram, Messenger, Instagram, WhatsApp oficial, chat web)'),
      h('div', { class: 'pre' }, st.text.trim() || '…'),
      h('div', { class: 'msg-buttons', role: 'list', 'aria-label': 'Vista previa de los botones' }, [...replies, ...urls].map((b) => h('span', { class: 'chip', role: 'listitem' }, b.kind === 'url' ? `🔗 ${b.label}` : b.label)))),
    h('div', {}, h('div', { class: 'small muted' }, 'Numerado (WhatsApp con QR y correo: contesta con el número o el texto)'), h('div', { class: 'pre' }, numbered)));
}

/** Botones de un mensaje del flujo: hasta 3 de respuesta (cada uno con lo que hace) y 2 de enlace. */
function buttonsEditor(st, refs, seqId) {
  const box = h('div');
  const preview = h('div');
  const drawPreview = () => fill(preview, buttonsPreview(st));
  const others = refs.sequences.filter((q) => q.id !== seqId);
  const count = (kind) => st.buttons.filter((b) => b.kind === kind).length;
  const draw = () => {
    fill(box,
      ...st.buttons.map((b, i) => {
        if (b.kind === 'reply' && b.action === 'start_sequence' && !b.sequence_id) b.sequence_id = others[0]?.id ?? null;
        return h('div', { class: 'list-item flow-button' },
          h('div', { class: 'grid' },
            field(b.kind === 'url' ? 'Texto del enlace' : `Botón ${st.buttons.slice(0, i + 1).filter((x) => x.kind === 'reply').length}`, text(b, 'label', { maxlength: 20, placeholder: b.kind === 'url' ? 'Ver menú' : 'Sí, me interesa' }), 'Máximo 20 caracteres.'),
            b.kind === 'url' ? field('Dirección', text(b, 'url', { type: 'url', placeholder: 'https://…' }), 'Debe empezar con https://')
              : field('Al tocarlo', select(b, 'action', BUTTON_ACTIONS, () => draw()))),
          b.kind === 'reply' && b.action === 'start_sequence' ? (others.length ? field('Flujo que empieza', select(b, 'sequence_id', others.map((q) => [q.id, q.name]))) : h('p', { class: 'small muted' }, 'Primero crea el otro flujo.')) : null,
          b.kind === 'reply' && b.action === 'tag' ? field('Etiqueta', text(b, 'tag', { placeholder: 'interesado' })) : null,
          b.kind === 'reply' ? field('Responder con (opcional)', area(b, 'reply'), 'Se envía al tocarlo, antes de hacer lo de arriba.') : null,
          h('button', { class: 'small danger', onclick: () => { st.buttons.splice(i, 1); draw(); } }, b.kind === 'url' ? 'Quitar enlace' : 'Quitar botón'));
      }),
      h('div', { class: 'row' },
        h('button', { class: 'small', disabled: count('reply') >= 3, onclick: () => { st.buttons.push(newButton('reply')); draw(); [...box.querySelectorAll('.flow-button')].at(-1)?.querySelector('input')?.focus(); } }, '+ Botón de respuesta'),
        h('button', { class: 'small', disabled: count('url') >= 2, onclick: () => { st.buttons.push(newButton('url')); draw(); [...box.querySelectorAll('.flow-button')].at(-1)?.querySelector('input')?.focus(); } }, '+ Botón de enlace')),
      count('reply') ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st.wait_for_choice, onchange: (e) => { st.wait_for_choice = e.target.checked; draw(); } }), 'Esperar a que elija antes del mensaje siguiente') : null,
      count('reply') && st.wait_for_choice ? field('Si llega la hora del mensaje siguiente y no eligió', select(st, 'if_no_choice', [['end', 'Terminar el flujo'], ['continue', 'Enviarlo de todos modos']])) : null,
      preview);
    drawPreview();
  };
  draw();
  // La vista previa sigue lo que se escribe (texto del mensaje y de los botones).
  return { box, refresh: drawPreview };
}

async function editSequence(root, id) {
  const refs = await automationRefs();
  const existing = id === 'new' ? null : refs.sequences.find((q) => q.id === id);
  if (id !== 'new' && !existing) throw new Error('Secuencia no encontrada');
  const q = draftModel(`sequence:${id}`, existing || { name: '', active: false, stop_on_reply: true, business_hours_only: true, steps: [{ delay_value: 0, delay_unit: 'minutes', at_time: '', text: '', image_id: '', conditions: [], buttons: [], wait_for_choice: false, if_no_choice: 'end' }] }, false);
  initializeDraftDefaults(`sequence:${id}`, () => q.steps.forEach(stepDefaults));
  root.append(draftNotice([`sequence:${id}`], render));
  const list = h('div');
  const timeline = h('ol', { class: 'small' });
  const drawTimeline = () => fill(timeline, q.steps.map((st, i) => h('li', {}, `Mensaje ${i + 1}: ${st.delay_value} ${Object.fromEntries(UNITS)[st.delay_unit]} ${i ? 'después del anterior' : 'desde el inicio'}${st.at_time ? `; siguiente ${st.at_time}` : ''}${q.business_hours_only ? '; respeta el horario del negocio' : ''}`)));
  const draw = () => fill(list, ...q.steps.map((st, i) => { stepDefaults(st); const buttons = buttonsEditor(st, refs, id); return h('div', { class: 'list-item', oninput: () => buttons.refresh() },
    h('div', { class: 'row between' }, h('strong', {}, `Mensaje ${i + 1}`),
      h('div', { class: 'row' },
        h('button', { class: 'small', disabled: i === 0, 'aria-label': `Mover mensaje ${i + 1} arriba`, onclick: () => { [q.steps[i - 1], q.steps[i]] = [q.steps[i], q.steps[i - 1]]; draw(); list.querySelectorAll(':scope > .list-item')[i - 1]?.querySelector('textarea')?.focus(); } }, '↑'),
        h('button', { class: 'small danger', disabled: q.steps.length === 1, onclick: () => { q.steps.splice(i, 1); draw(); } }, 'Quitar'))),
    h('div', { class: 'grid' },
      field(i === 0 ? 'Esperar desde que inicia' : 'Esperar desde el mensaje anterior', h('div', { class: 'row' }, h('div', { style: 'width:90px' }, num(st, 'delay_value', { min: 0 })), select(st, 'delay_unit', UNITS))),
      field('A esta hora (opcional)', h('input', { type: 'time', value: st.at_time, oninput: (e) => (st.at_time = e.target.value) }), 'Ej.: al día siguiente a las 10:00')),
    field('Mensaje', area(st, 'text'), VARS_HELP),
    field('Imagen (opcional)', photoPicker(st, 'image_id', refs)),
    field('Archivo (opcional)', attachmentPicker(st, refs)),
    waTemplateField(st, refs.waTemplates),
    h('details', { open: st.buttons.length > 0 }, h('summary', {}, `Botones (${st.buttons.length})`), buttons.box),
    h('details', {}, h('summary', {}, `Enviar solo si… (${st.conditions.length})`), typedList(st.conditions, CONDITIONS, (c) => conditionFields(c)))); }));
  draw();
  const save = async () => {
    const version = draftVersion(`sequence:${id}`);
    const saved = await run(() => (existing ? api('PUT', `/api/sequences/${id}`, q) : api('POST', '/api/sequences', { ...q, account_id: state.accountId || undefined })), 'Flujo guardado ✅');
    if (saved) { discardDraft(`sequence:${id}`, version); location.hash = '#/automation/sequences'; }
  };
  root.append(
    h('a', { href: '#/automation/sequences' }, '← Flujos'),
    h('div', { class: 'card' },
      field('Nombre', text(q, 'name', { placeholder: 'Seguimiento de cotización' })),
      check(q, 'active', 'Activo'),
      check(q, 'stop_on_reply', 'Detener si el cliente responde (tocar un botón no cuenta como responder)'),
      check(q, 'business_hours_only', 'Enviar solo en horario del negocio (lo que caiga fuera se pasa a la siguiente apertura)')),
    h('details', { class: 'card', ontoggle: () => drawTimeline() }, h('summary', {}, 'Ver línea temporal del seguimiento'), timeline),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Mensajes'), list,
      h('button', { onclick: () => { q.steps.push({ delay_value: 1, delay_unit: 'days', at_time: '', text: '', image_id: '', conditions: [], buttons: [], wait_for_choice: false, if_no_choice: 'end' }); draw(); } }, '+ Agregar mensaje')),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      existing.active ? h('a', { class: 'btn', href: `#/automation/campaigns/new?flow=${id}` }, 'Enviar a un grupo de clientes') : null,
      h('button', { class: 'danger', onclick: async () => { if (await confirmAction('¿Eliminar el flujo? Se detendrá para todos los que están en él.')) { if (!(await run(() => api('DELETE', `/api/sequences/${id}`), 'Eliminado'))) return; location.hash = '#/automation/sequences'; } } }, 'Eliminar')) : null),
  );
}

/* ------------------------------ Campañas ------------------------------ */

const CAMPAIGN_STATUS = { draft: ['', 'Borrador'], scheduled: ['orange', 'Programada'], sending: ['orange', 'Enviando'], sent: ['green', 'Enviada'], cancelled: ['red', 'Cancelada'] };

async function listCampaigns(root) {
  const [camps, channels] = await Promise.all([api('GET', withAcct('/api/campaigns')), api('GET', withAcct('/api/channels'))]);
  const chName = Object.fromEntries(channels.map((c) => [c.id, c.name]));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Envía un mensaje o un flujo a un grupo de clientes (por etiqueta o actividad reciente), ahora o en una fecha. Nunca se envía a quien se dio de baja, y los envíos van espaciados para proteger tu número.'),
      h('a', { class: 'btn primary', href: '#/automation/campaigns/new' }, '+ Nueva campaña')),
    h('div', { class: 'card' },
      camps.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Campaña'), h('th', {}, 'Canal'), h('th', {}, 'Estado'), h('th', {}, 'Enviados'), h('th', {}, 'Omitidos'), h('th', {}, 'Fecha'))),
            h('tbody', {}, camps.map((c) => {
              const [cls, label] = CAMPAIGN_STATUS[c.status];
              return h('tr', { class: 'click', onclick: () => (location.hash = `#/automation/campaigns/${c.id}`) },
                h('td', {}, h('strong', {}, c.name), c.kind === 'sequence' ? h('span', { class: 'badge' }, ' flujo') : null), h('td', {}, chName[c.channel_id] || ''),
                h('td', {}, h('span', { class: `badge ${cls}` }, label)),
                h('td', {}, c.stats.sent ?? 0), h('td', {}, c.stats.skipped ?? 0),
                h('td', { class: 'small muted' }, c.scheduled_at ? fmtDate(c.scheduled_at) : ''));
            })))
        : h('p', { class: 'muted' }, 'Aún no hay campañas.')),
  );
}

async function editCampaign(root, id) {
  const [refs, channels, info] = await Promise.all([automationRefs(), api('GET', withAcct('/api/channels')), api('GET', withAcct('/api/agenda/info'))]);
  state.timeZone = info.timezone;
  const existing = id === 'new' ? null : (await api('GET', withAcct('/api/campaigns'))).find((c) => c.id === id);
  if (id !== 'new' && !existing) throw new Error('Campaña no encontrada');
  // "Enviar a un grupo" desde un flujo: la campaña nueva ya lleva ese flujo.
  const fromFlow = id === 'new' ? new URLSearchParams(location.hash.split('?')[1] || '').get('flow') : null;
  const flows = refs.sequences.filter((q) => q.active);
  const flowName = fromFlow ? refs.sequences.find((q) => q.id === fromFlow)?.name ?? '' : '';
  const c = draftModel(`campaign:${id}`, existing || { name: flowName ? `Flujo: ${flowName}` : '', channel_id: channels[0]?.id || '', message: '', image_id: null, audience: { tags_any: [], tags_none: [], active_within_days: 0, statuses: [] }, scheduled_at: null, rate_per_minute: 20, business_hours_only: true, status: 'draft', kind: fromFlow ? 'sequence' : 'message', sequence_id: fromFlow }, false);
  initializeDraftDefaults(`campaign:${id}`, () => { c.image_id ??= ''; c.flow_step ??= 0; c.channel_ids ??= []; c.kind ??= 'message'; c.sequence_id ??= null; });
  const editable = ['draft', 'scheduled'].includes(c.status);
  const local = draftModel(`campaign-time:${id}`, { when: localDateTime(c.scheduled_at, info.timezone) }, false);
  root.append(draftNotice([`campaign:${id}`, `campaign-time:${id}`], render));
  const previewBox = h('div');
  // Varios números: la campaña también sale desde los otros canales del mismo tipo (cada cliente recibe desde el número que ya conoce).
  c.channel_ids ??= [];
  const extraBox = h('div');
  const drawExtra = () => {
    const prim = channels.find((ch) => ch.id === c.channel_id);
    const others = channels.filter((ch) => ch.id !== c.channel_id && prim && ch.type === prim.type);
    fill(extraBox, others.length ? h('div', { class: 'field' },
      h('span', {}, 'También enviar desde (reparte la carga)'),
      others.map((ch) => h('label', { class: 'check' }, h('input', { type: 'checkbox', disabled: !editable, checked: c.channel_ids.includes(ch.id), onchange: (e) => { c.channel_ids = e.target.checked ? [...c.channel_ids, ch.id] : c.channel_ids.filter((x) => x !== ch.id); } }), `${ch.name}${ch.config?.number ? ` (+${ch.config.number})` : ''}`)),
      h('small', {}, 'Cada cliente recibe el mensaje desde el número con el que ya hablaba. Cada número lleva su propio ritmo, así la campaña termina antes sin arriesgar a ninguno.')) : null);
  };
  drawExtra();
  const body = () => ({ ...c, image_id: c.image_id || null, scheduled_local: local.when || null, account_id: state.accountId || undefined });
  const save = async () => {
    const versions = [`campaign:${id}`, `campaign-time:${id}`].map((key) => [key, draftVersion(key)]);
    const saved = await run(() => (existing ? api('PUT', `/api/campaigns/${id}`, body()) : api('POST', '/api/campaigns', body())), 'Campaña guardada');
    if (saved) versions.forEach(([key, version]) => discardDraft(key, version));
    if (saved && !existing) location.hash = `#/automation/campaigns/${saved.id}`;
    return saved;
  };
  let launching = false;
  const reviewAndLaunch = async () => {
    if (launching) return; launching = true;
    try {
      const proposed = body(); const fingerprint = JSON.stringify(proposed);
      const preview = await run(() => api('POST', `/api/campaigns/${id}/preview`, proposed));
      if (!preview) return;
      if (JSON.stringify(body()) !== fingerprint) return toast('Cambiaste la campaña. Revisa de nuevo los destinatarios.', true);
      if (!preview.count) return toast('No hay destinatarios disponibles para esta campaña.', true);
      const flowName = c.kind === 'sequence' ? refs.sequences.find((q) => q.id === c.sequence_id)?.name ?? '' : '';
      const review = h('div', {}, h('p', {}, `${preview.count} destinatarios · ${preview.excluded_no_consent || 0} excluidos por falta de consentimiento`), h('p', {}, `Conexiones: ${[c.channel_id, ...c.channel_ids].map((key) => channels.find((ch) => ch.id === key)?.name || key).join(', ')}`), h('p', {}, local.when ? `Fecha: ${local.when.replace('T', ' ')} · ${info.timezone}` : 'Envío inmediato'),
        c.kind === 'sequence' ? h('p', {}, `Flujo "${flowName}": ${preview.messages_per_person} mensaje${preview.messages_per_person === 1 ? '' : 's'} por persona (${preview.total_messages} en total, cuentan para el cupo de tu plan).`) : h('div', { class: 'pre' }, c.message),
        preview.warning ? h('p', { class: 'banner warn' }, preview.warning) : null);
      if (!(await dialog('Revisa la campaña antes de enviarla', review, local.when ? 'Confirmar programación' : 'Confirmar envío ahora'))) return;
      if (JSON.stringify(body()) !== fingerprint) return toast('Cambiaste la campaña. Revisa de nuevo antes de enviar.', true);
      if (!(await save())) return;
      // Guardar una campaña ya programada reprograma sus jobs en el servidor; no lanzarla dos veces.
      if (c.status === 'scheduled' || await run(() => api('POST', `/api/campaigns/${id}/launch`), 'Campaña en marcha')) render();
    } finally { launching = false; }
  };
  // Qué se envía: un mensaje (con foto o plantilla) o un flujo completo (sus mensajes y botones, a su hora).
  const whatBox = h('div');
  const drawWhat = () => fill(whatBox,
    h('fieldset', { class: 'field' }, h('legend', {}, '¿Qué quieres enviar?'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'campaign-kind', value: 'message', disabled: !editable, checked: c.kind !== 'sequence', onchange: () => { c.kind = 'message'; drawWhat(); } }), 'Un mensaje'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'campaign-kind', value: 'sequence', disabled: !editable, checked: c.kind === 'sequence', onchange: () => { c.kind = 'sequence'; c.sequence_id ||= flows[0]?.id ?? null; drawWhat(); } }), 'Un flujo (varios mensajes, con botones)')),
    c.kind === 'sequence'
      ? [flows.length ? field('Flujo', select(c, 'sequence_id', flows.map((q) => [q.id, `${q.name} (${q.steps.length} mensaje${q.steps.length === 1 ? '' : 's'})`]))) : h('p', { class: 'banner warn' }, 'No tienes flujos activos. Crea uno en Automatización → Flujos.'),
        h('p', { class: 'small muted' }, 'Cada persona entra al flujo: el primer mensaje sale con la campaña y los siguientes a su hora (por ejemplo, un día después), espaciados al ritmo de la campaña para cuidar tu número. Si el cliente toca un botón, pasa lo que dice el botón.')]
      : [field('Mensaje', area(c, 'message', { big: true }), VARS_HELP),
        field('Imagen (opcional)', photoPicker(c, 'image_id', refs), 'Con texto, la foto sale con el mensaje como pie en un solo envío.'),
        waTemplateField(c, refs.waTemplates),
        field('Etapa del recorrido al enviarla', num(c, 'flow_step', { min: 0, max: 50 }), 'Si es el primer mensaje de un recorrido, indica la etapa en la que queda cada conversación: el asistente sigue el flujo desde ahí cuando el cliente responda. 0 = no cambia.')]);
  drawWhat();
  const statusBox = h('div');
  if (existing) {
    const [cls, label] = CAMPAIGN_STATUS[c.status];
    const recipients = await api('GET', `/api/campaigns/${id}/recipients`);
    fill(statusBox, h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Estado: ', h('span', { class: `badge ${cls}` }, label)),
        h('div', { class: 'row' },
          editable ? h('button', { class: 'small', onclick: async () => { const p = await run(() => api('POST', `/api/campaigns/${id}/preview`, body())); if (p) fill(previewBox, h('p', {}, h('strong', {}, `${p.count} destinatarios`), p.sample.length ? `: ${p.sample.join(', ')}${p.count > p.sample.length ? '…' : ''}` : ''), p.excluded_no_consent ? h('p', { class: 'small' }, `⚠️ ${p.excluded_no_consent} cliente${p.excluded_no_consent === 1 ? '' : 's'} del segmento quedan fuera porque no han aceptado recibir promociones (se registra cuando escriben ACEPTO o tú lo marcas en su ficha).`) : null, p.warning ? h('p', { class: 'badge orange' }, p.warning) : null); } }, 'Ver destinatarios') : null,
          editable ? h('button', { class: 'primary small', onclick: () => reviewAndLaunch() }, local.when ? 'Revisar y programar' : 'Revisar y enviar') : null,
          ['scheduled', 'sending'].includes(c.status) ? h('button', { class: 'small danger', onclick: async () => { if (await confirmAction(c.kind === 'sequence' ? '¿Cancelar la campaña? El flujo se detiene para todos los que siguen en él.' : '¿Cancelar la campaña?')) { if (!(await run(() => api('POST', `/api/campaigns/${id}/cancel`), 'Cancelada'))) return; render(); } } }, 'Cancelar') : null,
          c.kind === 'sequence' && c.status === 'sent' ? h('button', { class: 'small danger', onclick: async () => { if (await confirmAction('¿Detener el flujo para todos los que siguen en él? Ya no recibirán sus mensajes siguientes.')) { if (!(await run(() => api('POST', `/api/campaigns/${id}/cancel`), 'Flujo detenido'))) return; render(); } } }, 'Detener el flujo') : null)),
      previewBox,
      recipients.length ? h('details', {}, h('summary', {}, `Destinatarios (${recipients.length}) · ${c.stats.sent ?? 0} enviados · ${c.stats.skipped ?? 0} omitidos`),
        h('table', {}, h('tbody', {}, recipients.map((r) => h('tr', {}, h('td', {}, r.name || r.push_name || (r.phone ? `+${r.phone}` : '—')), h('td', {}, r.status), h('td', { class: 'small muted' }, r.reason)))))) : null));
  }
  root.append(
    h('a', { href: '#/automation/campaigns' }, '← Campañas'),
    statusBox,
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre', text(c, 'name', { placeholder: 'Promoción de octubre' })),
        field('Canal', select(c, 'channel_id', channels.map((ch) => [ch.id, `${ch.name} (${ch.label})`]), () => { c.channel_ids = []; if (editable) { drawExtra(); } }))),
      extraBox,
      whatBox),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'A quién'),
      h('div', { class: 'grid' },
        field('Con alguna de estas etiquetas', lines(c.audience, 'tags_any', { placeholder: 'interesado\nvip' }), 'Vacío = todos'),
        field('Sin estas etiquetas', lines(c.audience, 'tags_none', { placeholder: 'ya_compro' })),
        field('Que escribieron en los últimos (días)', num(c.audience, 'active_within_days', { min: 0 }), '0 = sin límite')),
    ),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Cuándo y a qué ritmo'),
      h('div', { class: 'grid' },
        field('Fecha y hora de envío', h('input', { type: 'datetime-local', value: local.when, oninput: (e) => (local.when = e.target.value) }), `Zona del negocio: ${info.timezone}. Vacío = enviar ahora.`),
        field('Mensajes por minuto', num(c, 'rate_per_minute', { min: 1, max: 120 }), 'Recomendado para WhatsApp: 10–30')),
      check(c, 'business_hours_only', 'Enviar solo en horario de atención (lo que no alcance sale en la siguiente apertura)'),
      h('p', { class: 'small muted' }, 'No se envía a quien se dio de baja ni a conversaciones que está atendiendo una persona.')),
    editable ? saveBar(c.status === 'scheduled' ? reviewAndLaunch : save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (await confirmAction('¿Eliminar la campaña?')) { if (!(await run(() => api('DELETE', `/api/campaigns/${id}`), 'Eliminada'))) return; location.hash = '#/automation/campaigns'; } } }, 'Eliminar')) : null) : null,
  );
}

/* ------------------------------ Horario y ajustes ------------------------------ */

const DAY_NAMES = { mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo' };

/** Editor de horario semanal: "09:00-14:00, 16:00-19:00" por día. */
export function hoursEditor(hours) {
  const toText = (list) => (list || []).map(([a, b]) => `${a}-${b}`).join(', ');
  return h('div', { class: 'grid' }, Object.entries(DAY_NAMES).map(([d, label]) =>
    field(label, h('input', {
      type: 'text', value: toText(hours[d]), placeholder: 'Cerrado',
      oninput: (e) => {
        // Acepta "9-18", "9:30-14" o "09:00-18:00".
        const hhmm = (y) => { const [hh, mm = '00'] = y.trim().replace('.', ':').split(':'); return `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`; };
        hours[d] = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('-').map(hhmm));
      },
    }))));
}

async function editSettings(root) {
  const s = draftModel('settings', await api('GET', withAcct('/api/settings')), false);
  root.append(draftNotice(['settings'], render));
  const team = (await api('GET', withAcct('/api/users')).catch(() => [])).filter((u) => u.account_id && u.active);
  const copy = (v) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(v); toast('Copiado'); } catch { toast('No se pudo copiar', true); } } }, 'Copiar');
  root.append(
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Horario del negocio'),
      h('p', { class: 'small muted' }, 'Formato por día: 09:00-14:00, 16:00-19:00 (vacío = cerrado). Lo usan el asistente (para responder "¿están abiertos?"), la agenda, las secuencias, las campañas y la condición "horario del negocio".'),
      field('Zona horaria', text(s, 'timezone')),
      hoursEditor(s.business_hours),
      field('Días cerrados (festivos)', lines(s, 'holidays', { placeholder: '2026-12-25\n2027-01-01' }), 'Formato AAAA-MM-DD, uno por renglón.')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Bajas (dejar de recibir mensajes)'),
      check(s.opt_out, 'enabled', 'Permitir que el cliente se dé de baja escribiendo una palabra'),
      h('div', { class: 'grid' },
        field('Palabras para darse de baja', lines(s.opt_out, 'keywords'), 'El mensaje debe ser exactamente una de ellas.'),
        field('Palabras para volver a recibir', lines(s.opt_out, 'resume_keywords'))),
      field('Respuesta al darse de baja', area(s.opt_out, 'confirm_message')),
      field('Respuesta al volver', area(s.opt_out, 'resume_message')),
      check(s.opt_out, 'footer_enabled', 'Agregar a cada campaña y secuencia cómo darse de baja (recomendado; muchas leyes lo exigen)'),
      field('Texto del pie', text(s.opt_out, 'footer_text'), '{{palabra_baja}} se reemplaza por la primera palabra de baja de arriba, en mayúsculas.'),
      h('p', { class: 'small muted' }, 'Quien se da de baja no recibe campañas, secuencias ni mensajes de reglas; sí recibe recordatorios de sus citas.')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Protección del número de WhatsApp'),
      field('Tope de mensajes de campaña por número y por día', num(s.sending, 'daily_cap_per_number', { min: 0 }), '0 = sin tope. Lo que no cabe hoy se envía al día siguiente. Para números nuevos, empezar con 50–100 al día reduce el riesgo de bloqueo.')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Consentimiento para promociones'),
      check(s.consent, 'require_for_campaigns', 'Enviar campañas y secuencias solo a quienes aceptaron recibirlas (recomendado)'),
      h('div', { class: 'grid' },
        field('Frases con las que aceptan', lines(s.consent, 'opt_in_keywords'), 'El mensaje debe ser exactamente una de ellas.'),
        field('Respuesta al aceptar', area(s.consent, 'opt_in_message'))),
      h('p', { class: 'small muted' }, 'Quien escribe una de esas frases queda registrado con fecha. También puedes marcarlo a mano en la ficha de cada cliente. Los mensajes de servicio (respuestas, recordatorios de citas) no necesitan este consentimiento. Los clientes anteriores a esta función quedaron como aceptados.')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Privacidad: cuánto tiempo guardar los datos'),
      h('div', { class: 'grid' },
        field('Borrar mensajes con más de … días', num(s.retention, 'messages_days', { min: 0 }), '0 = conservarlos siempre. También se limpian los resúmenes de esas conversaciones.'),
        field('Borrar contactos sin actividad en … días', num(s.retention, 'inactive_contacts_days', { min: 0 }), '0 = nunca. No se borran contactos con citas futuras.')),
      h('p', { class: 'small muted' }, 'El borrado es automático (cada pocas horas) y no se puede deshacer; los respaldos antiguos pueden conservar los datos hasta que se renueven. Para atender la solicitud de una sola persona usa "Borrar todos sus datos" en su ficha.')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Reparto de conversaciones por turnos (round robin)'),
      check(s.assignment, 'enabled', 'Asignar automáticamente cada conversación que pasa a una persona, una a una, entre el equipo'),
      h('div', { class: 'row' }, [['agent', 'Agentes'], ['admin', 'Administradores']].map(([r, l]) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: s.assignment.roles.includes(r), onchange: (e) => { s.assignment.roles = e.target.checked ? [...s.assignment.roles, r] : s.assignment.roles.filter((x) => x !== r); } }), l))),
      team.length ? h('div', {}, h('p', { class: 'small muted', style: 'margin:6px 0' }, 'Solo estas personas (si no marcas a nadie, todas las de los roles elegidos):'),
        h('div', { class: 'row' }, team.map((u) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: s.assignment.user_ids.includes(u.id), onchange: (e) => { s.assignment.user_ids = e.target.checked ? [...s.assignment.user_ids, u.id] : s.assignment.user_ids.filter((x) => x !== u.id); } }),
          u.name || u.email, u.available === false ? ' (no disponible)' : '')))) : null,
      check(s.assignment, 'notify_all', 'Además de la persona asignada, avisar a todo el equipo'),
      h('p', { class: 'small muted' }, 'Cada persona recibe una notificación en el panel (y por WhatsApp si lo tiene activado). Quien esté marcado como "no disponible" se salta sin perder su lugar. También puedes asignar a mano desde cada conversación o con la acción "Asignar a alguien del equipo" en las reglas.')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Equipo'),
      check(s, 'notify_team_on_handoff', 'Avisar en el panel a todo el equipo cuando una conversación pasa a una persona')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Avisos si se desconecta un WhatsApp'),
      h('p', { class: 'small muted' }, 'La sesión que vinculas con el código QR se conserva aunque se reinicie el servidor. Si se pierde la conexión, se intenta recuperar sola; si no vuelve, se avisa según lo que definas aquí. Si se cerró la sesión desde el teléfono, el aviso dice que hay que volver a escanear el QR.'),
      check(s.connection_alerts, 'enabled', 'Enviar avisos cuando un WhatsApp se desconecta'),
      h('div', { class: 'grid' },
        field('Avisar después de (minutos)', num(s.connection_alerts, 'after_minutes', { min: 0, max: 1440 }), '0 = de inmediato. Unos minutos evitan avisos por cortes breves que se recuperan solos.'),
        field('Repetir el aviso cada (horas)', num(s.connection_alerts, 'repeat_hours', { min: 0, max: 168 }), 'Mientras siga desconectado, hasta 7 días. 0 = avisar una sola vez.')),
      check(s.connection_alerts, 'notify_admins', 'Avisar a los administradores (en el panel y por correo)'),
      h('div', { class: 'grid' },
        field('Correos adicionales', lines(s.connection_alerts, 'emails', { placeholder: 'dueno@minegocio.com' }), 'Uno por renglón (máximo 10).'),
        field('WhatsApp adicionales', lines(s.connection_alerts, 'phones', { placeholder: '5215512345678' }), 'Con lada, uno por renglón (máximo 5). Se envía desde otro WhatsApp conectado de la cuenta: el que se desconectó no puede enviar.')),
      check(s.connection_alerts, 'notify_reconnected', 'Avisar también cuando vuelva a conectarse'),
      h('button', { class: 'small', onclick: async () => {
        const r = await run(() => api('POST', withAcct('/api/settings/test-connection-alert')));
        if (!r) return;
        const parts = [r.admins ? `${r.admins} administrador(es)` : '', r.emails ? `${r.emails} correo(s)` : '', r.phones ? `${r.phones} WhatsApp` : ''].filter(Boolean);
        toast(parts.length ? `Alerta de prueba enviada a ${parts.join(', ')}${r.failed.length ? `; no se pudo enviar a ${r.failed.join(', ')}` : ''}` : 'No hay a quién avisar: activa a los administradores o agrega correos o WhatsApp.', !parts.length || r.failed.length > 0);
      } }, 'Enviar alerta de prueba (con lo guardado)')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Integraciones'),
      h('p', {}, 'Calendario de citas para Google Calendar / Outlook / Apple (suscribirse por URL):'),
      h('p', {}, h('code', {}, s.ics_url), ' ', copy(s.ics_url)),
      h('p', {}, 'Clave para verificar los webhooks salientes (cabecera ', h('code', {}, 'X-Signature: sha256=HMAC'), '):'),
      h('p', {}, h('code', {}, s.webhook_secret), ' ', copy(s.webhook_secret)),
      h('button', { class: 'small', onclick: async () => { if (await confirmAction('Se generarán nuevas URL y claves; las anteriores dejarán de funcionar.')) { if (!(await run(() => api('POST', withAcct('/api/settings/rotate-secrets')), 'Claves regeneradas'))) return; render(); } } }, 'Regenerar URL y claves')),
    saveBar(async () => {
      const { ics_url, ...body } = s;
      void ics_url;
      const version = draftVersion('settings');
      if (await run(() => api('PUT', withAcct('/api/settings'), body), 'Guardado ✅')) { discardDraft('settings', version); render(); }
    }),
  );
}
