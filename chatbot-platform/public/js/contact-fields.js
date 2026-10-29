import { api, dialog, field, fill, h, run, select, state, text, toast } from './core.js';
import { isAdmin, isSuper, withAcct } from './session.js';
import { dataLabel } from './bot.js';
import { resetVarsCache } from './vars-help.js';

export const FIELD_TYPES = [['text', 'Texto'], ['number', 'Número'], ['date', 'Fecha'], ['option', 'Lista de opciones'], ['email', 'Correo'], ['phone', 'Teléfono']];
const TYPE_NAME = Object.fromEntries(FIELD_TYPES);

/** «Datos de tus clientes» de la cuenta (la ayuda de variables y la ficha los usan). */
export const loadContactFields = () => (isSuper() && !state.accountId ? Promise.resolve([]) : api('GET', withAcct('/api/contact-fields')));

/** Etiqueta de un dato guardado: la del campo de la cuenta, la del agente o la clave legible. */
export const fieldLabel = (key, ...lists) => lists.flat().find((f) => f?.key === key)?.label || dataLabel(key);

/** Control para editar un dato según su tipo; escribe en obj[key]. */
export function fieldControl(f, obj, key = f.key) {
  const v = obj[key] ?? '';
  if (f.type === 'option') {
    // Un valor guardado antes de existir la lista se conserva como opción.
    const opts = [['', '(sin elegir)'], ...f.options.map((o) => [o, o]), ...(v && !f.options.includes(v) ? [[v, v]] : [])];
    return select(obj, key, opts);
  }
  // Una fecha que el asistente guardó con palabras («15 de mayo») se edita como texto, para no perderla.
  if (f.type === 'date' && (!v || /^\d{4}-\d{2}-\d{2}$/.test(v))) return text(obj, key, { type: 'date' });
  if (f.type === 'number') return text(obj, key, { inputmode: 'decimal' });
  if (f.type === 'email') return text(obj, key, { type: 'email', autocomplete: 'off' });
  if (f.type === 'phone') return text(obj, key, { type: 'tel', autocomplete: 'off' });
  return text(obj, key);
}

/** Cómo se lee un dato en una ficha: la fecha AAAA-MM-DD en palabras. */
export function fieldText(f, v) {
  if (f?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  return String(v);
}

const keyFrom = (label) => label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1').slice(0, 64);

function fieldForm(m, isNew) {
  const options = h('textarea', { value: (m.options || []).join('\n'), placeholder: 'Una por renglón', oninput: (e) => (m.options = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)) });
  const optionsBox = field('Opciones', options, 'Una por renglón. La ficha muestra una lista para elegir.');
  optionsBox.hidden = m.type !== 'option';
  const key = text(m, 'key', { pattern: '[a-z][a-z0-9_]{0,63}', required: true, disabled: !isNew });
  let touched = !isNew;
  key.addEventListener('input', () => (touched = true));
  const label = text(m, 'label', { required: true, maxlength: 80, oninput: () => { if (!touched) { m.key = keyFrom(m.label); key.value = m.key; } } });
  return h('div', { class: 'stack' },
    field('Etiqueta', label, 'Como lo ve tu equipo, p. ej. «Fecha de cumpleaños».'),
    field('Clave', key, isNew ? 'Para las variables: {{campo.clave}}. Solo minúsculas, números y guion bajo; no se puede cambiar después.' : 'No se puede cambiar: los datos guardados y las variables dependen de ella.'),
    field('Tipo', select(m, 'type', FIELD_TYPES, (t) => (optionsBox.hidden = t !== 'option'))),
    optionsBox);
}

const validForm = (m) => {
  if (!m.label?.trim()) return toast('Escribe la etiqueta', true), false;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(m.key || '')) return toast('La clave lleva solo minúsculas, números y guion bajo, empezando con una letra', true), false;
  if (m.type === 'option' && !m.options?.length) return toast('Escribe al menos una opción', true), false;
  return true;
};

/** Ajustes → «Datos de tus clientes». */
export async function viewContactFields(root) {
  const list = h('div', { class: 'stack' });
  const admin = isAdmin();
  const draw = async () => {
    resetVarsCache();
    const fields = await loadContactFields();
    if (!root.isConnected) return;
    const move = async (i, d) => {
      const ids = fields.map((f) => f.id);
      [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
      if (await run(() => api('PUT', withAcct('/api/contact-fields/order'), { ids }))) draw();
    };
    fill(list, ...(fields.length ? [h('table', { class: 'responsive-table' },
      h('thead', {}, h('tr', {}, ...['Dato', 'Tipo', 'Variable', ''].map((s) => h('th', {}, s)))),
      h('tbody', {}, ...fields.map((f, i) => h('tr', {},
        h('td', {}, h('strong', {}, f.label)),
        h('td', {}, TYPE_NAME[f.type] || f.type, f.type === 'option' ? h('div', { class: 'small muted' }, f.options.join(', ')) : null),
        h('td', {}, h('code', {}, `{{campo.${f.key}}}`)),
        h('td', {}, admin ? h('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap' },
          h('button', { class: 'small', disabled: i === 0, 'aria-label': `Subir ${f.label}`, onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'small', disabled: i === fields.length - 1, 'aria-label': `Bajar ${f.label}`, onclick: () => move(i, 1) }, '↓'),
          h('button', { class: 'small', onclick: async () => {
            const m = { ...f, options: [...f.options] };
            if (!(await dialog(`Editar «${f.label}»`, fieldForm(m, false), 'Guardar', () => validForm(m)))) return;
            if (await run(() => api('PUT', `/api/contact-fields/${f.id}`, { label: m.label, type: m.type, options: m.options }), 'Campo guardado')) draw();
          } }, 'Editar'),
          h('button', { class: 'small danger', onclick: async () => {
            if (!(await dialog('Borrar campo', h('p', {}, `Se quita «${f.label}» de la ficha. Lo que ya tienen guardado tus clientes se conserva en sus datos.`), 'Borrar'))) return;
            if (await run(() => api('DELETE', `/api/contact-fields/${f.id}`), 'Campo borrado')) draw();
          } }, 'Borrar')) : null))))),
    ] : [h('p', { class: 'muted' }, 'Todavía no tienes datos propios. Agrega lo que quieras guardar de cada cliente: cumpleaños, número de cliente, plan…')]));
  };
  const add = async () => {
    const m = { label: '', key: '', type: 'text', options: [] };
    if (!(await dialog('Nuevo dato de tus clientes', fieldForm(m, true), 'Agregar', () => validForm(m)))) return;
    if (await run(() => api('POST', withAcct('/api/contact-fields'), m), 'Campo agregado')) draw();
  };
  root.append(
    h('a', { class: 'breadcrumb', href: '#/ajustes' }, '← Ajustes'),
    h('div', { class: 'row between' }, h('h1', {}, 'Datos de tus clientes'), admin ? h('button', { class: 'primary', onclick: add }, 'Agregar dato') : null),
    h('p', { class: 'help' }, 'Lo que guardas de cada cliente: aparece en su ficha, en la importación y exportación, y como {{campo.clave}} en tus mensajes. El asistente no los pide; eso se configura en las preguntas de cada agente.'),
    h('div', { class: 'card' }, list),
    admin ? h('div', { class: 'card stack' }, h('h2', {}, 'Importar y exportar'), h('p', { class: 'small' }, 'En Contactos puedes importar un CSV con estas columnas (por su etiqueta o su clave) y exportar todos tus contactos.'), h('a', { class: 'btn small', href: '#/contacts' }, 'Ir a Contactos')) : null,
  );
  await draw();
}

/** Contactos → «Importar contactos» (solo administradores). */
export async function importContactsDialog() {
  const [channels, fields] = await Promise.all([api('GET', withAcct('/api/channels')), loadContactFields()]);
  const wa = channels.filter((c) => c.type === 'whatsapp');
  if (!wa.length) { toast('Para importar necesitas un canal de WhatsApp: los contactos se identifican por su teléfono', true); return; }
  const m = { channel_id: wa[0].id };
  const file = h('input', { type: 'file', accept: '.csv,text/csv', required: true });
  const columns = ['telefono', 'nombre', 'etiquetas', ...fields.map((f) => f.label)];
  const body = h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Un archivo CSV con encabezados. Obligatorio: ', h('strong', {}, 'telefono'), ' (con lada de país, p. ej. 5215512345678). Opcionales: ', columns.slice(1).join(', '), '. Las etiquetas van separadas por punto y coma. Una celda vacía no borra lo que ya tiene el contacto; importar no dispara reglas ni envía mensajes.'),
    wa.length > 1 ? field('Canal de WhatsApp', select(m, 'channel_id', wa.map((c) => [c.id, c.name]))) : null,
    field('Archivo', file, 'Hasta 5,000 contactos. Una exportación de Contactos se puede volver a importar.'));
  if (!(await dialog('Importar contactos', body, 'Importar', () => file.reportValidity()))) return;
  const csv = await file.files[0].text();
  const r = await run(() => api('POST', '/api/contacts/import', { channel_id: m.channel_id, csv }));
  if (!r) return;
  const errors = r.errors.slice(0, 50);
  await dialog('Importación terminada', h('div', { class: 'stack', role: 'status' },
    h('p', {}, `${r.created} ${r.created === 1 ? 'contacto nuevo' : 'contactos nuevos'} y ${r.updated} ${r.updated === 1 ? 'actualizado' : 'actualizados'}.`),
    r.ignored_columns.length ? h('p', { class: 'small muted' }, `Columnas que no se importaron (no son un dato de tus clientes): ${r.ignored_columns.join(', ')}.`) : null,
    errors.length ? h('div', {}, h('p', { class: 'error' }, `${r.errors.length} ${r.errors.length === 1 ? 'fila no se importó' : 'filas no se importaron'}:`), h('ul', { class: 'small' }, ...errors.map((e) => h('li', {}, `Fila ${e.row}: ${e.error}`))), r.errors.length > errors.length ? h('p', { class: 'small muted' }, `…y ${r.errors.length - errors.length} más.`) : null) : null), 'Listo');
  return r;
}
