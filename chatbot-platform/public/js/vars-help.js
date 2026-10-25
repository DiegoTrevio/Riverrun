import { field, fill, h, state } from './core.js';
import { loadContactFields } from './contact-fields.js';

/**
 * Ayuda de variables según el lugar: cada mensaje muestra solo las que aplican ahí (una regla de pagos, las del cobro;
 * un recordatorio de cita, las de la cita…) y cada una se inserta con un clic donde está el cursor.
 */
const CLIENT = [
  ['nombre', 'Su primer nombre'], ['nombre_completo', 'Su nombre completo'], ['telefono', 'Su teléfono'],
  ['negocio', 'El nombre de tu negocio o agente'], ['canal', 'El canal por el que escribe'], ['link', 'Enlace a la conversación (para tu equipo)'],
  ['fecha_hoy', 'La fecha de hoy'], ['asesor', 'La persona del equipo asignada'],
  ['saldo', 'Lo que te debe en total (cobros pendientes)'], ['pagos_pendientes', 'Cuántos cobros tiene pendientes'],
  ['proxima_cita.fecha', 'Fecha de su próxima cita'], ['proxima_cita.hora', 'Hora de su próxima cita'], ['proxima_cita.servicio', 'Servicio de su próxima cita'],
];
const MESSAGE = [['cliente', 'Su nombre, o su teléfono si no lo dio'], ['mensaje', 'Lo que escribió el cliente']];
const APPOINTMENT = [
  ['cita.servicio', 'Servicio'], ['cita.fecha', 'Fecha'], ['cita.hora', 'Hora'], ['cita.lugar', 'Lugar'], ['cita.tipo', '«cita» o «llamada»'],
  ['cita.persona', 'Quién atiende'], ['cita.enlace', 'Enlace de la videollamada'],
];
const PAYMENT = [
  ['pago.concepto', 'Concepto'], ['pago.monto', 'Monto'], ['pago.vencimiento', 'Fecha de vencimiento'], ['pago.dias_atraso', 'Días de atraso'],
  ['pago.dias_para_vencer', 'Días para que venza'], ['pago.link', 'Enlace de pago'], ['pago.instrucciones', 'Cómo pagar'],
  ['pago.referencia', 'Referencia'], ['pago.parcialidad', '«2 de 3» en pagos en parcialidades'],
];
const QUOTE = [['cotizacion.folio', 'Folio'], ['cotizacion.total', 'Total'], ['cotizacion.vigencia', 'Vigente hasta']];

/** Variables de cada lugar. `trigger` (reglas) es el disparador elegido. */
export function varsFor(context, trigger = '') {
  switch (context) {
    case 'rule': return [
      ...CLIENT, ...MESSAGE,
      ...(trigger.startsWith('appointment_') ? APPOINTMENT : []),
      ...(trigger.startsWith('payment_') ? PAYMENT : []),
      ...(trigger.startsWith('quote_') ? QUOTE : []),
    ];
    case 'appointment': return [...CLIENT, ...APPOINTMENT];
    case 'payment': return [...CLIENT, ...PAYMENT];
    case 'alert': return [...CLIENT, ...MESSAGE];
    default: return CLIENT; // secuencias, campañas y plantillas de WhatsApp
  }
}

let cache = { account: null, fields: null };
/** Tras crear, editar o borrar un campo: la próxima lista los vuelve a leer. */
export const resetVarsCache = () => { cache = { account: null, fields: null }; };
const accountFields = async () => {
  if (cache.account !== state.accountId || !cache.fields) cache = { account: state.accountId, fields: loadContactFields().catch(() => { resetVarsCache(); return []; }) };
  return cache.fields;
};

/** Inserta {{variable}} donde está el cursor y avisa al formulario (oninput) del cambio. */
export function insertVar(input, name) {
  const v = `{{${name}}}`;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + v + input.value.slice(end);
  input.focus();
  input.setSelectionRange(start + v.length, start + v.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Lista desplegable de variables para un cuadro de texto. `trigger` puede ser una función (el disparador cambia). */
export function varsHelp(input, context, { trigger } = {}) {
  const list = h('div', { class: 'vars-list', role: 'group', 'aria-label': 'Variables para insertar' });
  const box = h('details', { class: 'vars-help' }, h('summary', {}, 'Variables (clic para insertar)'), list);
  const draw = async () => {
    const vars = varsFor(context, (typeof trigger === 'function' ? trigger() : trigger) || '');
    const own = (await accountFields()).map((f) => [`campo.${f.key}`, f.label]);
    const button = ([name, desc]) => h('button', { type: 'button', class: 'small var-chip', title: desc, 'aria-label': `Insertar {{${name}}}: ${desc}`, onclick: () => insertVar(input, name) }, `{{${name}}}`);
    fill(list, ...vars.map(button),
      ...(own.length ? [h('p', { class: 'small muted vars-group' }, 'Datos de tus clientes'), ...own.map(button)] : []),
      h('p', { class: 'small muted vars-group' }, 'También: {{dato.clave}} con cualquier dato guardado del cliente. Una variable que no aplica queda vacía.'));
  };
  box.addEventListener('toggle', () => { if (box.open) draw(); });
  return box;
}

/** Un cuadro de texto con su ayuda de variables debajo. */
export function varsField(label, input, context, opts = {}) {
  return h('div', { class: 'vars-field' }, field(label, input, opts.help), varsHelp(input, context, opts));
}
