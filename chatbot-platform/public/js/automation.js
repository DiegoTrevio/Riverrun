import { needAccount } from './admin.js';
import { messageTester, saveBar } from './bot.js';
import { api, area, check, clone, field, fill, fmtDate, h, lines, num, run, select, state, text, toast } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';

const AUTO_TABS = [['rules', 'Reglas'], ['sequences', 'Secuencias'], ['campaigns', 'Campañas'], ['settings', 'Horario y ajustes']];

export async function viewAutomation(root, tab, id) {
  root.append(
    h('h1', {}, 'Automatización'),
    h('div', { class: 'tabs' }, AUTO_TABS.map(([k, l]) => h('a', { href: `#/automation/${k}`, class: k === tab ? 'active' : '' }, l))),
  );
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
  const images = [];
  for (const b of bots) for (const img of await api('GET', `/api/chatbots/${b.id}/images`)) images.push({ ...img, bot: b.name });
  const files = await api('GET', withAcct('/api/attachments'));
  return { bots, sequences, users: users.filter((u) => u.account_id), services, images, files };
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
  webhook: 'Enviar a otro sistema (webhook)',
};

const CONDITIONS = {
  channel: 'Canal',
  business_hours: 'Horario del negocio',
  has_tag: 'Etiqueta',
  field: 'Dato del cliente',
  status: 'Estado de la conversación',
  agent: 'Asistente activo o en pausa',
};

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
  { name: 'Agradecer cita agendada', trigger: { type: 'appointment_booked' }, actions: [{ type: 'send_message', text: 'Te esperamos el {{cita.fecha}} a las {{cita.hora}} 🙌', delay_minutes: 1 }] },
];

function triggerSummary(t) {
  switch (t.type) {
    case 'message_received':
      return t.match === 'any' ? 'Cualquier mensaje' : `Mensaje ${t.match === 'exact' ? 'igual a' : 'con'}: ${t.keywords.join(', ')}`;
    case 'intent': return `Intención: ${t.intent}`;
    case 'no_reply': return `Sin respuesta en ${t.minutes >= 60 ? `${Math.round(t.minutes / 60 * 10) / 10} h` : `${t.minutes} min`}`;
    case 'data_captured': return `Dato guardado${t.field ? `: ${t.field}` : ''}`;
    case 'tag_added': return `Etiqueta: ${t.tag}`;
    case 'stage_reached': return t.step ? `Llega a la etapa ${t.step}` : 'Llega a cualquier etapa';
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
      h('h3', {}, 'Plantillas rápidas'),
      h('div', { class: 'row' }, RULE_TEMPLATES.map((t) => h('button', { class: 'small', onclick: () => create(t) }, t.name)))),
    bots.length ? h('details', { class: 'card' }, h('summary', {}, h('strong', {}, '🧪 Probar palabras'), h('span', { class: 'small muted' }, ' — qué reglas se activan con un mensaje')), messageTester(bots)) : null,
    h('div', { class: 'card' },
      rules.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Regla'), h('th', {}, 'Cuando'), h('th', {}, 'Acciones'), h('th', {}, 'Veces'), h('th', {}, ''))),
            h('tbody', {}, rules.map((r) => h('tr', {},
              h('td', {}, h('a', { href: `#/automation/rules/${r.id}` }, h('strong', {}, r.name)), ' ', r.active ? null : h('span', { class: 'badge orange' }, 'inactiva'), r.stop_ai ? h('div', { class: 'small muted' }, 'la IA no responde') : null),
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
        h('select', { onchange: (e) => { if (e.target.value) { list.push({ type: e.target.value }); e.target.value = ''; draw(); onChange?.(); } } },
          h('option', { value: '' }, '+ Agregar…'),
          Object.entries(types).map(([k, l]) => h('option', { value: k }, l)))));
  };
  draw();
  return box;
}

export const VARS_HELP = 'Variables: {{nombre}}, {{cliente}}, {{telefono}}, {{negocio}}, {{mensaje}}, {{link}}, {{dato.CAMPO}}, {{cita.servicio}}, {{cita.fecha}}, {{cita.hora}}, {{cita.lugar}}';

const ACCEPT_FILES = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.mp3,.ogg,.wav,.m4a,.mp4,.mov,.webm';
const KIND_LABEL = { document: 'documento', audio: 'audio', video: 'video', image: 'imagen' };

/** Elegir un archivo de la biblioteca o subir uno nuevo (PDF, Word, Excel, audio, video… hasta 16 MB). */
function attachmentPicker(obj, refs) {
  const sel = h('select', { onchange: (e) => { obj.attachment_id = e.target.value; } },
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
          field('Foto (opcional)', select(a, 'image_id', [['', '— Sin imagen —'], ...refs.images.map((i) => [i.id, `${i.name} (${i.bot})`])])),
          field('Esperar antes de enviar (minutos)', num(a, 'delay_minutes', { min: 0 }), '0 = de inmediato')),
        field('Archivo (opcional)', attachmentPicker(a, refs)),
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
    case 'webhook':
      a.url ??= '';
      return [field('URL', text(a, 'url', { placeholder: 'https://hook.n8n.io/…' }), 'Se envía un POST con los datos del cliente, firmado con la cabecera X-Signature (clave en Horario y ajustes).')];
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
  const r = existing ? clone(existing) : { name: '', active: true, chatbot_id: null, stop_ai: false, priority: 0, trigger: { type: 'message_received', match: 'keywords', keywords: [] }, conditions: [], actions: [] };
  r.chatbot_id ??= '';
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
      f.push(field('Etapa del recorrido', h('select', { onchange: (e) => { t.step = Number(e.target.value); } },
        [[0, 'Cualquier etapa'], ...Array.from({ length: n }, (_, i) => [i + 1, `Etapa ${i + 1}${steps[i]?.title ? `: ${steps[i].title}` : ''}`])].map(([v, l]) => h('option', { value: v, selected: v === t.step }, l))),
        'Se dispara cuando el asistente marca que la conversación llegó a esa etapa (una vez por cambio de etapa). Elige el asistente en la regla para ver los nombres de sus etapas.'));
    } else if (t.type === 'tag_added') {
      t.tag ??= '';
      f.push(field('Etiqueta', text(t, 'tag')));
    } else if (t.type === 'no_reply') {
      t.minutes ??= 60;
      f.push(field('Minutos sin respuesta del cliente (después de nuestro último mensaje)', num(t, 'minutes', { min: 1 }), '60 = 1 hora · 1440 = 1 día. Se envía una sola vez por cada silencio.'));
    } else if (t.type === 'appointment_booked' || t.type === 'appointment_cancelled') {
      t.service_id ??= '';
      f.push(field('Servicio', select(t, 'service_id', [['', 'Cualquiera'], ...refs.services.map((s) => [s.id, s.name])])));
    }
    fill(trigBox, field('Cuando…', select(r.trigger, 'type', Object.entries(TRIGGERS), (v) => { r.trigger = { type: v }; drawTrigger(); })), ...f);
  };
  drawTrigger();
  const save = async () => {
    if (r.actions.some((a) => a.type === 'send_message' && !a.text?.trim() && !a.image_id && !a.attachment_id)) return toast('En "Enviar mensaje" escribe un mensaje o elige una foto o un archivo', true);
    const body = { ...r, chatbot_id: r.chatbot_id || null, account_id: state.accountId || undefined };
    const saved = await run(() => (existing ? api('PUT', `/api/automations/${id}`, body) : api('POST', '/api/automations', body)), 'Regla guardada ✅');
    if (saved) location.hash = '#/automation/rules';
  };
  root.append(
    h('a', { href: '#/automation/rules' }, '← Reglas'),
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre de la regla', text(r, 'name', { placeholder: 'Alerta de quejas' })),
        field('Aplica a', select(r, 'chatbot_id', [['', 'Todos los chatbots de la cuenta'], ...refs.bots.map((b) => [b.id, b.name])], () => { if (r.trigger.type === 'stage_reached') drawTrigger(); }))),
      check(r, 'active', 'Activa'),
      check(r, 'stop_ai', 'Si se cumple, la IA no responde ese mensaje (la regla se encarga)')),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '1. Cuándo'), trigBox),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '2. Solo si… (opcional)'), typedList(r.conditions, CONDITIONS, (c) => conditionFields(c))),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '3. Hacer'), typedList(r.actions, ACTIONS, (a) => actionFields(a, refs))),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Eliminar la regla?')) { await run(() => api('DELETE', `/api/automations/${id}`), 'Eliminada'); location.hash = '#/automation/rules'; } } }, 'Eliminar')) : null),
  );
}

/* ------------------------------ Secuencias ------------------------------ */

const UNITS = [['minutes', 'minutos'], ['hours', 'horas'], ['days', 'días']];

async function listSequences(root) {
  const seqs = await api('GET', withAcct('/api/sequences'));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Una secuencia es una serie de mensajes programados (por ejemplo: hoy, en 2 días y en una semana). Se inicia con una regla o desde una conversación, respeta el horario del negocio y se detiene si el cliente responde.'),
      h('a', { class: 'btn primary', href: '#/automation/sequences/new' }, '+ Nueva secuencia')),
    h('div', { class: 'card' },
      seqs.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Secuencia'), h('th', {}, 'Pasos'), h('th', {}, 'En curso'), h('th', {}, 'Completadas'), h('th', {}, 'Detenidas'))),
            h('tbody', {}, seqs.map((q) => h('tr', { class: 'click', onclick: () => (location.hash = `#/automation/sequences/${q.id}`) },
              h('td', {}, h('strong', {}, q.name), q.active ? null : h('span', { class: 'badge orange' }, ' inactiva')),
              h('td', {}, q.steps.length),
              h('td', {}, q.enrollments.active ?? 0), h('td', {}, q.enrollments.completed ?? 0), h('td', {}, q.enrollments.stopped ?? 0)))))
        : h('p', { class: 'muted' }, 'Aún no hay secuencias.')),
  );
}

async function editSequence(root, id) {
  const refs = await automationRefs();
  const existing = id === 'new' ? null : refs.sequences.find((q) => q.id === id);
  if (id !== 'new' && !existing) throw new Error('Secuencia no encontrada');
  const q = existing ? clone(existing) : { name: '', active: true, stop_on_reply: true, business_hours_only: true, steps: [{ delay_value: 0, delay_unit: 'minutes', at_time: '', text: '', image_id: '', conditions: [] }] };
  const list = h('div');
  const draw = () => fill(list, ...q.steps.map((st, i) => h('div', { class: 'list-item' },
    h('div', { class: 'row between' }, h('strong', {}, `Mensaje ${i + 1}`),
      h('div', { class: 'row' },
        h('button', { class: 'small', disabled: i === 0, onclick: () => { [q.steps[i - 1], q.steps[i]] = [q.steps[i], q.steps[i - 1]]; draw(); } }, '↑'),
        h('button', { class: 'small danger', disabled: q.steps.length === 1, onclick: () => { q.steps.splice(i, 1); draw(); } }, 'Quitar'))),
    h('div', { class: 'grid' },
      field(i === 0 ? 'Esperar desde que inicia' : 'Esperar desde el mensaje anterior', h('div', { class: 'row' }, h('div', { style: 'width:90px' }, num(st, 'delay_value', { min: 0 })), select(st, 'delay_unit', UNITS))),
      field('A esta hora (opcional)', h('input', { type: 'time', value: st.at_time, oninput: (e) => (st.at_time = e.target.value) }), 'Ej.: al día siguiente a las 10:00')),
    field('Mensaje', area(st, 'text'), VARS_HELP),
    field('Imagen (opcional)', select(st, 'image_id', [['', '— Sin imagen —'], ...refs.images.map((im) => [im.id, `${im.name} (${im.bot})`])])),
    field('Archivo (opcional)', attachmentPicker(st, refs)),
    h('details', {}, h('summary', {}, `Enviar solo si… (${st.conditions.length})`), typedList(st.conditions, CONDITIONS, (c) => conditionFields(c))))));
  draw();
  const save = async () => {
    const saved = await run(() => (existing ? api('PUT', `/api/sequences/${id}`, q) : api('POST', '/api/sequences', { ...q, account_id: state.accountId || undefined })), 'Secuencia guardada ✅');
    if (saved) location.hash = '#/automation/sequences';
  };
  root.append(
    h('a', { href: '#/automation/sequences' }, '← Secuencias'),
    h('div', { class: 'card' },
      field('Nombre', text(q, 'name', { placeholder: 'Seguimiento de cotización' })),
      check(q, 'active', 'Activa'),
      check(q, 'stop_on_reply', 'Detener si el cliente responde'),
      check(q, 'business_hours_only', 'Enviar solo en horario del negocio (lo que caiga fuera se pasa a la siguiente apertura)')),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Mensajes'), list,
      h('button', { onclick: () => { q.steps.push({ delay_value: 1, delay_unit: 'days', at_time: '', text: '', image_id: '', conditions: [] }); draw(); } }, '+ Agregar mensaje')),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Eliminar la secuencia? Se detendrá para todos los inscritos.')) { await run(() => api('DELETE', `/api/sequences/${id}`), 'Eliminada'); location.hash = '#/automation/sequences'; } } }, 'Eliminar')) : null),
  );
}

/* ------------------------------ Campañas ------------------------------ */

const CAMPAIGN_STATUS = { draft: ['', 'Borrador'], scheduled: ['orange', 'Programada'], sending: ['orange', 'Enviando'], sent: ['green', 'Enviada'], cancelled: ['red', 'Cancelada'] };

async function listCampaigns(root) {
  const [camps, channels] = await Promise.all([api('GET', withAcct('/api/campaigns')), api('GET', withAcct('/api/channels'))]);
  const chName = Object.fromEntries(channels.map((c) => [c.id, c.name]));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Envía un mensaje a un grupo de clientes (por etiqueta o actividad reciente), ahora o en una fecha. Nunca se envía a quien se dio de baja, y los envíos van espaciados para proteger tu número.'),
      h('a', { class: 'btn primary', href: '#/automation/campaigns/new' }, '+ Nueva campaña')),
    h('div', { class: 'card' },
      camps.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Campaña'), h('th', {}, 'Canal'), h('th', {}, 'Estado'), h('th', {}, 'Enviados'), h('th', {}, 'Omitidos'), h('th', {}, 'Fecha'))),
            h('tbody', {}, camps.map((c) => {
              const [cls, label] = CAMPAIGN_STATUS[c.status];
              return h('tr', { class: 'click', onclick: () => (location.hash = `#/automation/campaigns/${c.id}`) },
                h('td', {}, h('strong', {}, c.name)), h('td', {}, chName[c.channel_id] || ''),
                h('td', {}, h('span', { class: `badge ${cls}` }, label)),
                h('td', {}, c.stats.sent ?? 0), h('td', {}, c.stats.skipped ?? 0),
                h('td', { class: 'small muted' }, c.scheduled_at ? fmtDate(c.scheduled_at) : ''));
            })))
        : h('p', { class: 'muted' }, 'Aún no hay campañas.')),
  );
}

async function editCampaign(root, id) {
  const [refs, channels] = await Promise.all([automationRefs(), api('GET', withAcct('/api/channels'))]);
  const existing = id === 'new' ? null : (await api('GET', withAcct('/api/campaigns'))).find((c) => c.id === id);
  if (id !== 'new' && !existing) throw new Error('Campaña no encontrada');
  const c = existing ? clone(existing) : { name: '', channel_id: channels[0]?.id || '', message: '', image_id: null, audience: { tags_any: [], tags_none: [], active_within_days: 0, statuses: [] }, scheduled_at: null, rate_per_minute: 20, business_hours_only: true, status: 'draft' };
  c.image_id ??= '';
  c.flow_step ??= 0;
  const editable = ['draft', 'scheduled'].includes(c.status);
  const local = { when: c.scheduled_at ? new Date(new Date(c.scheduled_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' };
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
  const body = () => ({ ...c, image_id: c.image_id || null, scheduled_at: local.when ? new Date(local.when).toISOString() : null, account_id: state.accountId || undefined });
  const save = async () => {
    const saved = await run(() => (existing ? api('PUT', `/api/campaigns/${id}`, body()) : api('POST', '/api/campaigns', body())), 'Campaña guardada');
    if (saved && !existing) location.hash = `#/automation/campaigns/${saved.id}`;
    return saved;
  };
  const statusBox = h('div');
  if (existing) {
    const [cls, label] = CAMPAIGN_STATUS[c.status];
    const recipients = await api('GET', `/api/campaigns/${id}/recipients`);
    fill(statusBox, h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Estado: ', h('span', { class: `badge ${cls}` }, label)),
        h('div', { class: 'row' },
          editable ? h('button', { class: 'small', onclick: async () => { const p = await run(() => api('POST', `/api/campaigns/${id}/preview`)); if (p) fill(previewBox, h('p', {}, h('strong', {}, `${p.count} destinatarios`), p.sample.length ? `: ${p.sample.join(', ')}${p.count > p.sample.length ? '…' : ''}` : ''), p.excluded_no_consent ? h('p', { class: 'small' }, `⚠️ ${p.excluded_no_consent} cliente${p.excluded_no_consent === 1 ? '' : 's'} del segmento quedan fuera porque no han aceptado recibir promociones (se registra cuando escriben ACEPTO o tú lo marcas en su ficha).`) : null, p.warning ? h('p', { class: 'badge orange' }, p.warning) : null); } }, 'Ver destinatarios') : null,
          editable ? h('button', { class: 'primary small', onclick: async () => { if (!(await save())) return; if (!confirm(local.when ? 'Se programará el envío. ¿Continuar?' : 'Se enviará AHORA a todos los destinatarios. ¿Continuar?')) return; if (await run(() => api('POST', `/api/campaigns/${id}/launch`), 'Campaña en marcha')) render(); } }, local.when ? 'Programar envío' : 'Enviar ahora') : null,
          ['scheduled', 'sending'].includes(c.status) ? h('button', { class: 'small danger', onclick: async () => { if (confirm('¿Cancelar la campaña?')) { await run(() => api('POST', `/api/campaigns/${id}/cancel`), 'Cancelada'); render(); } } }, 'Cancelar') : null)),
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
      field('Mensaje', area(c, 'message', { big: true }), VARS_HELP),
      field('Imagen (opcional)', select(c, 'image_id', [['', '— Sin imagen —'], ...refs.images.map((im) => [im.id, `${im.name} (${im.bot})`])]), 'Con texto, la foto sale con el mensaje como pie en un solo envío.'),
      field('Etapa del recorrido al enviarla', num(c, 'flow_step', { min: 0, max: 50 }), 'Si es el primer mensaje de un recorrido, indica la etapa en la que queda cada conversación: el asistente sigue el flujo desde ahí cuando el cliente responda. 0 = no cambia.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'A quién'),
      h('div', { class: 'grid' },
        field('Con alguna de estas etiquetas', lines(c.audience, 'tags_any', { placeholder: 'interesado\nvip' }), 'Vacío = todos'),
        field('Sin estas etiquetas', lines(c.audience, 'tags_none', { placeholder: 'ya_compro' })),
        field('Que escribieron en los últimos (días)', num(c.audience, 'active_within_days', { min: 0 }), '0 = sin límite')),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Cuándo y a qué ritmo'),
      h('div', { class: 'grid' },
        field('Fecha y hora de envío', h('input', { type: 'datetime-local', value: local.when, oninput: (e) => (local.when = e.target.value) }), 'Vacío = al pulsar "Enviar ahora"'),
        field('Mensajes por minuto', num(c, 'rate_per_minute', { min: 1, max: 120 }), 'Recomendado para WhatsApp: 10–30')),
      check(c, 'business_hours_only', 'Enviar solo en horario de atención (lo que no alcance sale en la siguiente apertura)'),
      h('p', { class: 'small muted' }, 'No se envía a quien se dio de baja ni a conversaciones que está atendiendo una persona.')),
    editable ? saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Eliminar la campaña?')) { await run(() => api('DELETE', `/api/campaigns/${id}`), 'Eliminada'); location.hash = '#/automation/campaigns'; } } }, 'Eliminar')) : null) : null,
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
  const s = await api('GET', withAcct('/api/settings'));
  const team = (await api('GET', withAcct('/api/users')).catch(() => [])).filter((u) => u.account_id && u.active);
  const copy = (v) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(v); toast('Copiado'); } catch { toast('No se pudo copiar', true); } } }, 'Copiar');
  root.append(
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Horario del negocio'),
      h('p', { class: 'small muted' }, 'Formato por día: 09:00-14:00, 16:00-19:00 (vacío = cerrado). Lo usan el asistente (para responder "¿están abiertos?"), la agenda, las secuencias, las campañas y la condición "horario del negocio".'),
      field('Zona horaria', text(s, 'timezone')),
      hoursEditor(s.business_hours),
      field('Días cerrados (festivos)', lines(s, 'holidays', { placeholder: '2026-12-25\n2027-01-01' }), 'Formato AAAA-MM-DD, uno por renglón.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Bajas (dejar de recibir mensajes)'),
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
      h('h3', { style: 'margin-top:0' }, 'Protección del número de WhatsApp'),
      field('Tope de mensajes de campaña por número y por día', num(s.sending, 'daily_cap_per_number', { min: 0 }), '0 = sin tope. Lo que no cabe hoy se envía al día siguiente. Para números nuevos, empezar con 50–100 al día reduce el riesgo de bloqueo.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Consentimiento para promociones'),
      check(s.consent, 'require_for_campaigns', 'Enviar campañas y secuencias solo a quienes aceptaron recibirlas (recomendado)'),
      h('div', { class: 'grid' },
        field('Frases con las que aceptan', lines(s.consent, 'opt_in_keywords'), 'El mensaje debe ser exactamente una de ellas.'),
        field('Respuesta al aceptar', area(s.consent, 'opt_in_message'))),
      h('p', { class: 'small muted' }, 'Quien escribe una de esas frases queda registrado con fecha. También puedes marcarlo a mano en la ficha de cada cliente. Los mensajes de servicio (respuestas, recordatorios de citas) no necesitan este consentimiento. Los clientes anteriores a esta función quedaron como aceptados.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Privacidad: cuánto tiempo guardar los datos'),
      h('div', { class: 'grid' },
        field('Borrar mensajes con más de … días', num(s.retention, 'messages_days', { min: 0 }), '0 = conservarlos siempre. También se limpian los resúmenes de esas conversaciones.'),
        field('Borrar contactos sin actividad en … días', num(s.retention, 'inactive_contacts_days', { min: 0 }), '0 = nunca. No se borran contactos con citas futuras.')),
      h('p', { class: 'small muted' }, 'El borrado es automático (cada pocas horas) y no se puede deshacer; los respaldos antiguos pueden conservar los datos hasta que se renueven. Para atender la solicitud de una sola persona usa "Borrar todos sus datos" en su ficha.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Reparto de conversaciones por turnos (round robin)'),
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
      h('h3', { style: 'margin-top:0' }, 'Equipo'),
      check(s, 'notify_team_on_handoff', 'Avisar en el panel a todo el equipo cuando una conversación pasa a una persona')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Integraciones'),
      h('p', {}, 'Calendario de citas para Google Calendar / Outlook / Apple (suscribirse por URL):'),
      h('p', {}, h('code', {}, s.ics_url), ' ', copy(s.ics_url)),
      h('p', {}, 'Clave para verificar los webhooks salientes (cabecera ', h('code', {}, 'X-Signature: sha256=HMAC'), '):'),
      h('p', {}, h('code', {}, s.webhook_secret), ' ', copy(s.webhook_secret)),
      h('button', { class: 'small', onclick: async () => { if (confirm('Se generarán nuevas URL y claves; las anteriores dejarán de funcionar.')) { await run(() => api('POST', withAcct('/api/settings/rotate-secrets')), 'Claves regeneradas'); render(); } } }, 'Regenerar URL y claves')),
    saveBar(async () => {
      const { ics_url, ...body } = s;
      void ics_url;
      if (await run(() => api('PUT', withAcct('/api/settings'), body), 'Guardado ✅')) render();
    }),
  );
}
