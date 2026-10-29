import { needAccount } from './admin.js';
import { api, area, check, confirmAction, dialog, field, fill, fmtDate, h, run, select, settingsSection, text, toast, named } from './core.js';
import { render } from './main.js';
import { isAdmin, withAcct } from './session.js';

/* ============================== Cotizaciones ============================== */

const TABS = [['precios', 'Lista de precios'], ['formatos', 'Formatos'], ['historial', 'Cotizaciones'], ['ajustes', 'Ajustes']];

export const PRICE_MODE = { exact: 'Precio exacto', from: 'Desde (precio mínimo)', range: 'Rango (mínimo a máximo)', tbd: 'Por confirmar (sin precio)' };
const IVA_MODE = { plus: 'Se suma el IVA', included: 'El precio ya incluye IVA', exempt: 'Exento de IVA' };
export const KIND = { approximate: ['orange', 'Aproximada'], final: ['green', 'Final'] };
export const STATUS = {
  draft: ['', 'En preparación'], pending_approval: ['orange', 'Por aprobar'], approved: ['green', 'Aprobada'], sent: ['green', 'Enviada'], accepted: ['green', 'Aceptada por el cliente'],
  rejected: ['red', 'Rechazada'], expired: ['', 'Vencida'], failed: ['red', 'Con error'],
};

const moneyFormats = new Map();
export function money(cents, currency = 'MXN') {
  if (cents === null || cents === undefined) return '';
  if (!moneyFormats.has(currency)) moneyFormats.set(currency, new Intl.NumberFormat('es-MX', { style: 'currency', currency, minimumFractionDigits: 2 }));
  return moneyFormats.get(currency).format(cents / 100);
}

/** Precio de un concepto tal como lo ve el cliente. */
export function unitPrice(i, currency) {
  if (i.price_mode === 'tbd') return 'Por confirmar';
  if (i.price_mode === 'from') return `desde ${money(i.price_min, currency)}`;
  if (i.price_mode === 'range') return `${money(i.price_min, currency)} a ${money(i.price_max, currency)}`;
  return money(i.price_min, currency);
}

/** Total de una cotización: exacto, rango, «desde» y si quedan conceptos por confirmar. */
export function totalText(q) {
  const c = q.currency;
  let s = q.open_ended ? `desde ${money(q.total_min, c)}` : q.total_min === q.total_max ? money(q.total_min, c) : `${money(q.total_min, c)} a ${money(q.total_max, c)}`;
  if (q.has_tbd) s = q.total_max === 0 ? 'Por confirmar' : `${s} + por confirmar`;
  return s;
}

export function lineAmount(l, c) {
  if (l.price_mode === 'tbd') return 'Por confirmar';
  if (l.price_mode === 'from') return `desde ${money(l.amount_min, c)}`;
  return l.amount_min === l.amount_max ? money(l.amount_min, c) : `${money(l.amount_min, c)} a ${money(l.amount_max, c)}`;
}

export const badge = ([color, label]) => h('span', { class: `badge ${color}` }, label);
const toCents = (v) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v) * 100));
const toPesos = (c) => (c === null || c === undefined ? '' : String(c / 100));

export async function viewQuotes(root, tab = 'precios', params = new URLSearchParams()) {
  root.append(
    h('h1', {}, 'Cotizaciones'),
    h('nav', { class: 'tabs', 'aria-label': 'Secciones de cotizaciones' }, TABS.map(([k, l]) => h('a', { href: `#/cotizaciones/${k}`, class: k === tab ? 'active' : '', 'aria-current': k === tab ? 'page' : null }, l))),
  );
  if (needAccount(root)) return;
  const body = h('div');
  root.append(body);
  if (tab === 'ajustes') return viewSettings(body);
  if (tab === 'formatos') return viewTemplates(body);
  if (tab === 'historial') return params.get('id') ? viewQuote(body, params.get('id')) : listQuotes(body, params);
  return viewPrices(body, params.get('id'));
}

/* ------------------------------ Lista de precios ------------------------------ */

async function viewPrices(root, editId) {
  const [items, settings] = await Promise.all([api('GET', withAcct('/api/price-items')), api('GET', withAcct('/api/quote-settings'))]);
  root.append(h('div', { class: 'page-intro' },
    h('p', { class: 'muted' },
      'Lo que el asistente puede cotizar. Usa precio exacto si lo sabes; «desde», rango o «por confirmar» si depende de los detalles (sale como APROXIMADA). ',
      'Los totales salen siempre de esta lista.'),
    h('a', { class: 'btn primary', href: '#/cotizaciones/precios?id=new' }, '+ Nuevo concepto')));
  if (editId) {
    const existing = editId === 'new' ? null : items.find((i) => i.id === editId);
    if (editId !== 'new' && !existing) throw new Error('Concepto no encontrado');
    root.append(priceForm(existing, settings));
  }
  const open = (i) => (location.hash = `#/cotizaciones/precios?id=${i.id}`);
  root.append(h('div', { class: 'card' }, items.length
    ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Concepto'), h('th', {}, 'Clave'), h('th', {}, 'Precio'), h('th', {}, 'IVA'), h('th', {}, 'Estado'))),
        h('tbody', {}, items.map((i) => h('tr', { class: 'click', tabindex: '0', onclick: () => open(i), onkeydown: (e) => { if (e.key === 'Enter') open(i); } },
          h('td', {}, h('strong', {}, i.name), i.description ? h('div', { class: 'small muted' }, i.description) : null),
          h('td', { class: 'small' }, i.code),
          h('td', {}, unitPrice(i, settings.currency), h('span', { class: 'small muted' }, ` / ${i.unit}`)),
          h('td', { class: 'small' }, IVA_MODE[i.iva_mode]),
          h('td', {}, i.active ? badge(['green', 'Activo']) : badge(['', 'Inactivo']))))))
    // Sin conceptos: la lista vacía enseña cómo se ve cada tipo de precio (ejemplos, en gris y marcados como tales).
    : [h('p', { style: 'margin-top:0' }, h('strong', {}, 'Aún no hay conceptos. '), 'Agrega los servicios o productos que cotizas; así se verá tu lista:'),
      h('table', { class: 'example-table' },
        h('caption', { class: 'sr-only' }, 'Ejemplos de conceptos'),
        h('thead', {}, h('tr', {}, h('th', {}, 'Concepto (ejemplo)'), h('th', {}, 'Precio'), h('th', {}, 'Cómo sale en la cotización'))),
        h('tbody', {}, [
          ['Servicio con precio fijo', '$500.00 / servicio', 'Exacta'],
          ['Paquete que depende de los detalles', 'desde $1,200.00 / paquete', 'Aproximada'],
          ['Trabajo con precio variable', '$800.00 – $1,500.00 / trabajo', 'Aproximada'],
          ['Algo que hay que revisar antes', 'Por confirmar', 'Aproximada'],
        ].map(([name, price, kind]) => h('tr', {}, h('td', {}, name), h('td', {}, price), h('td', {}, kind)))))]));
}

function priceForm(existing, settings) {
  const m = existing
    ? { ...existing, min: toPesos(existing.price_min), max: toPesos(existing.price_max) }
    : { code: '', name: '', description: '', unit: 'servicio', price_mode: 'exact', min: '', max: '', iva_mode: settings.prices_include_iva ? 'included' : 'plus', active: true, sort: 0 };
  const cur = settings.currency;
  const amount = (key) => text(m, key, { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', required: true });
  const prices = h('div', { class: 'row' });
  const drawPrices = () => fill(prices,
    m.price_mode === 'tbd' ? h('p', { class: 'small muted' }, 'Sin precio: la cotización dirá «Por confirmar» en este concepto.')
      : m.price_mode === 'range' ? [field(`Mínimo (${cur})`, amount('min')), field(`Máximo (${cur})`, amount('max'))]
      : field(m.price_mode === 'from' ? `Desde (${cur})` : `Precio (${cur})`, amount('min')));
  drawPrices();
  const save = () => run(async () => {
    const body = {
      code: m.code.trim() || slug(m.name), name: m.name, description: m.description, unit: m.unit, price_mode: m.price_mode,
      price_min: m.price_mode === 'tbd' ? null : toCents(m.min), price_max: m.price_mode === 'range' ? toCents(m.max) : null,
      iva_mode: m.iva_mode, active: m.active, sort: Number(m.sort) || 0,
    };
    if (existing) await api('PUT', `/api/price-items/${existing.id}`, body);
    else await api('POST', withAcct('/api/price-items'), body);
    location.hash = '#/cotizaciones/precios';
  }, 'Concepto guardado');
  const remove = async () => {
    if (!(await confirmAction(`¿Eliminar «${existing.name}»? Las cotizaciones ya hechas no cambian.`))) return;
    await run(async () => { await api('DELETE', `/api/price-items/${existing.id}`); location.hash = '#/cotizaciones/precios'; render(); }, 'Concepto eliminado');
  };
  return h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, existing ? `Editar: ${existing.name}` : 'Nuevo concepto'),
    h('div', { class: 'row' },
      field('Nombre', text(m, 'name', { required: true, maxlength: 200, placeholder: 'Renta de salón' })),
      field('Unidad', text(m, 'unit', { maxlength: 40, placeholder: 'servicio, pieza, hora, persona' })),
      field('Clave', text(m, 'code', { maxlength: 40, placeholder: 'SALON' }), 'Se genera sola si la dejas vacía.')),
    field('Descripción (opcional)', area(m, 'description', { maxlength: 1000 }), 'Aparece en la cotización debajo del concepto.'),
    h('div', { class: 'row' },
      field('Tipo de precio', select(m, 'price_mode', Object.entries(PRICE_MODE), drawPrices)),
      field('IVA', select(m, 'iva_mode', Object.entries(IVA_MODE)))),
    prices,
    check(m, 'active', 'Activo (el asistente puede cotizarlo)'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: save }, 'Guardar concepto'),
      h('a', { class: 'btn', href: '#/cotizaciones/precios' }, 'Cancelar'),
      existing ? h('button', { class: 'danger', onclick: remove }, 'Eliminar') : null));
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'CONCEPTO';

/* ------------------------------ Formatos (Word) ------------------------------ */

const TAG_GROUPS = [
  ['Siempre (obligatorias)', [['tipo', 'COTIZACIÓN APROXIMADA o COTIZACIÓN FINAL'], ['total', 'Total con IVA (exacto, rango o «desde»)'], ['leyenda', 'La leyenda de aproximada o final de tus ajustes']]],
  ['Documento', [['folio', 'Folio consecutivo'], ['fecha', 'Fecha de la cotización'], ['vigencia', 'Válida hasta'], ['subtotal', 'Subtotal'], ['iva', 'IVA'], ['tasa_iva', 'Tasa de IVA'], ['moneda', 'Moneda'], ['notas', 'Notas del equipo']]],
  ['Cliente', [['nombre', 'Nombre'], ['telefono', 'Teléfono'], ['correo', 'Correo'], ['cliente.dato', 'Cualquier dato que pide tu agente (usa la clave del dato)']]],
  ['Negocio', [['negocio.nombre', 'Nombre'], ['negocio.telefono', 'Teléfono'], ['negocio.correo', 'Correo'], ['negocio.direccion', 'Dirección']]],
  ['Tabla de conceptos (en un renglón de la tabla)', [['#conceptos', 'Al inicio del renglón'], ['concepto', 'Nombre'], ['descripcion', 'Descripción'], ['cantidad', 'Cantidad'], ['unidad', 'Unidad'], ['precio_unitario', 'Precio'], ['importe', 'Importe'], ['/conceptos', 'Al final del renglón']]],
  ['Texto solo en un tipo', [['#es_aproximada', '… texto … {{/es_aproximada}}'], ['#es_final', '… texto … {{/es_final}}']]],
];

async function viewTemplates(root) {
  const listBox = h('div');
  const drawList = async () => {
    const templates = await api('GET', withAcct('/api/quote-templates'));
    fill(listBox, templates.length
      ? h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Formato'), h('th', {}, 'Versión'), h('th', {}, 'Estado'), h('th', {}, 'Subido'), h('th', {}, 'Acciones'))),
          h('tbody', {}, templates.map((t) => h('tr', {},
            h('td', {}, h('strong', {}, t.name)),
            h('td', {}, String(t.version)),
            h('td', {}, t.status === 'active' ? badge(['green', 'En uso']) : badge(['', 'Archivado'])),
            h('td', { class: 'small' }, fmtDate(t.created_at)),
            h('td', {}, h('div', { class: 'row' },
              h('a', { class: 'btn small', href: `/api/quote-templates/${t.id}/preview`, target: '_blank', rel: 'noopener', 'aria-label': `Vista previa de ${t.name} versión ${t.version}` }, 'Vista previa'),
              h('a', { class: 'btn small', href: `/api/quote-templates/${t.id}/file`, download: '', 'aria-label': `Descargar ${t.name} versión ${t.version}` }, 'Descargar'),
              t.status === 'active' ? h('button', { class: 'small', 'aria-label': `Archivar ${t.name}`, onclick: async () => {
                if (!(await confirmAction(`¿Archivar «${t.name}»? Los agentes que lo usan pasarán al formato más reciente o al del sistema.`))) return;
                await run(async () => { await api('DELETE', `/api/quote-templates/${t.id}`); await drawList(); }, 'Formato archivado');
              } }, 'Archivar') : null))))))
      : h('p', { class: 'muted' }, 'Aún no subes un formato: se usa el del sistema.'));
  };
  await drawList();
  const m = { name: '' };
  const file = h('input', { type: 'file', accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const report = h('div', { 'aria-live': 'polite' });
  const upload = () => run(async () => {
    if (!file.files[0]) throw new Error('Elige el archivo de Word (.docx)');
    const form = new FormData();
    form.append('name', m.name);
    form.append('file', file.files[0]);
    const r = await api('POST', withAcct('/api/quote-templates'), form, true);
    toast(`Formato «${r.template.name}» guardado (versión ${r.template.version})`);
    fill(report, r.report.unknown.length
      ? h('div', { class: 'banner warn', role: 'status' }, h('p', {}, 'El formato se guardó, pero estas marcas no las conoce el sistema y quedarán vacías:'),
          h('ul', {}, r.report.unknown.map((t) => h('li', {}, h('code', {}, `{{${t}}}`)))), h('p', { class: 'small' }, 'Revisa que estén bien escritas.'))
      : null);
    file.value = '';
    await drawList();
  });
  const copy = (tag) => h('button', { class: 'small', type: 'button', 'aria-label': `Copiar {{${tag}}}`, onclick: async () => {
    try { await navigator.clipboard.writeText(`{{${tag}}}`); toast(`Copiado {{${tag}}}`); } catch { toast('No se pudo copiar', true); }
  } }, 'Copiar');
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' },
        'Diseña tu cotización en Word (logo, colores, condiciones) y escribe marcas como {{nombre}} o {{total}} donde va cada dato. ',
        'El sistema solo reemplaza las marcas con lo que dio el cliente y con los montos de tu lista de precios; el cliente recibe un PDF. ',
        'Si no subes un formato, se usa el del sistema.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: withAcct('/api/quote-templates/example'), download: '' }, 'Descargar formato de ejemplo'),
        h('a', { class: 'btn', href: withAcct('/api/quote-templates/example?fmt=pdf'), target: '_blank', rel: 'noopener' }, 'Ver ejemplo en PDF'))),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Subir formato'),
      h('div', { class: 'row' },
        field('Nombre del formato', text(m, 'name', { maxlength: 80, placeholder: 'Membrete' }), 'Si subes otro con el mismo nombre, queda como versión nueva.'),
        field('Archivo de Word (.docx)', file)),
      h('button', { class: 'primary', onclick: upload }, 'Subir formato'),
      report),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Tus formatos'), listBox),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Marcas que puedes usar'),
      TAG_GROUPS.map(([title, tags]) => h('details', { open: title.startsWith('Siempre') },
        h('summary', {}, title),
        h('table', {}, h('tbody', {}, tags.map(([tag, what]) => h('tr', {}, h('td', {}, h('code', {}, `{{${tag}}}`)), h('td', { class: 'small' }, what), h('td', {}, copy(tag))))))))));
}

/* ------------------------------ Ajustes ------------------------------ */

async function viewSettings(root) {
  const s = await api('GET', withAcct('/api/quote-settings'));
  const m = { ...s, iva: String(Math.round(s.iva_rate * 10000) / 100) };
  const save = () => run(() => api('PUT', withAcct('/api/quote-settings'), {
    currency: m.currency, iva_rate: Number(m.iva) / 100, prices_include_iva: m.prices_include_iva, validity_days: Number(m.validity_days),
    legend_approx: m.legend_approx, legend_final: m.legend_final, folio_prefix: m.folio_prefix,
    business_name: m.business_name, business_phone: m.business_phone, business_email: m.business_email, business_address: m.business_address,
  }), 'Ajustes guardados');
  // Tres secciones en dos columnas (qué es, a la izquierda; sus campos, a la derecha) y un solo «Guardar ajustes».
  root.append(
    settingsSection('Montos y folios', 'Lo que se aplica a cada cotización nueva: el impuesto, la moneda, cuántos días vale y cómo se numera.',
      h('div', { class: 'row' },
        field('IVA (%)', text(m, 'iva', { type: 'number', min: 0, max: 99, step: '0.01', inputmode: 'decimal' })),
        field('Moneda', text(m, 'currency', { maxlength: 3, placeholder: 'MXN' })),
        field('Vigencia (días)', text(m, 'validity_days', { type: 'number', min: 1, max: 365 })),
        field('Prefijo del folio', text(m, 'folio_prefix', { maxlength: 12 }), `Siguiente folio: ${s.folio_prefix}${String(s.next_folio).padStart(4, '0')}`)),
      check(m, 'prices_include_iva', 'Los precios que escribo ya incluyen IVA (valor inicial de los conceptos nuevos)')),
    settingsSection('Leyendas', 'El texto que aclara al cliente si la cotización es aproximada o final.',
      field('Leyenda de cotización APROXIMADA', area(m, 'legend_approx', { maxlength: 500 }), 'Se imprime en el archivo con {{leyenda}}. El asistente también aclara en el chat que es aproximada.'),
      field('Leyenda de cotización FINAL', area(m, 'legend_final', { maxlength: 500 }))),
    settingsSection('Datos del negocio en la cotización', 'Se imprimen donde tu formato tenga {{negocio.nombre}}, {{negocio.telefono}}, {{negocio.correo}} y {{negocio.direccion}}.',
      h('div', { class: 'row' },
        field('Nombre del negocio', text(m, 'business_name', { maxlength: 300, placeholder: 'Si lo dejas vacío, se usa el nombre del perfil' })),
        field('Teléfono', text(m, 'business_phone', { maxlength: 300, type: 'tel' })),
        field('Correo', text(m, 'business_email', { maxlength: 300, type: 'email' }))),
      field('Dirección', text(m, 'business_address', { maxlength: 300 }))),
    h('div', { class: 'settings-actions' }, h('button', { class: 'primary', onclick: save }, 'Guardar ajustes')));
}

/* ------------------------------ Historial ------------------------------ */

async function listQuotes(root, params) {
  const f = { status: params.get('status') || '', kind: params.get('kind') || '', search: params.get('search') || '' };
  const box = h('div');
  const open = (q) => (location.hash = `#/cotizaciones/historial?id=${q.id}`);
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const quotes = await api('GET', withAcct(`/api/quotes${qs.size ? `?${qs}` : ''}`));
    fill(box, quotes.length
      ? h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Folio'), h('th', {}, 'Cliente'), h('th', {}, 'Tipo'), h('th', {}, 'Estado'), h('th', {}, 'Total'), h('th', {}, 'Fecha'))),
          h('tbody', {}, quotes.map((q) => h('tr', { class: 'click', tabindex: '0', onclick: () => open(q), onkeydown: (e) => { if (e.key === 'Enter') open(q); } },
            h('td', {}, h('strong', {}, q.folio)),
            h('td', {}, q.customer_snapshot?.nombre || h('span', { class: 'muted' }, 'Sin nombre')),
            h('td', {}, badge(KIND[q.kind])),
            h('td', {}, badge(STATUS[q.status] || ['', q.status])),
            h('td', {}, totalText(q)),
            h('td', { class: 'small' }, fmtDate(q.created_at))))))
      : h('p', { class: 'muted' }, 'Todavía no hay cotizaciones con estos filtros.'));
  };
  root.append(h('div', { class: 'card' },
    h('div', { class: 'row' },
      field('Estado', select(f, 'status', [['', 'Todos'], ...Object.entries(STATUS).map(([k, [, l]]) => [k, l])], load)),
      field('Tipo', select(f, 'kind', [['', 'Todos'], ['approximate', 'Aproximadas'], ['final', 'Finales']], load)),
      field('Buscar', text(f, 'search', { type: 'search', placeholder: 'Folio o cliente', onkeydown: (e) => { if (e.key === 'Enter') load(); } }))),
    box));
  await load();
}

async function viewQuote(root, id) {
  const q = await api('GET', `/api/quotes/${id}`);
  const c = q.currency;
  root.append(
    h('p', {}, h('a', { href: '#/cotizaciones/historial' }, '← Todas las cotizaciones')),
    h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', { style: 'margin:0' }, `Cotización ${q.folio} `, badge(KIND[q.kind]), ' ', badge(STATUS[q.status] || ['', q.status])),
        h('div', { class: 'row' },
          q.pdf_path ? h('a', { class: 'btn', href: `/api/quotes/${q.id}/file`, target: '_blank', rel: 'noopener' }, 'Ver PDF') : null,
          q.docx_path ? h('a', { class: 'btn', href: `/api/quotes/${q.id}/file?fmt=docx`, download: '' }, 'Descargar Word') : null,
          q.conversation_id ? h('a', { class: 'btn', href: `#/conversation/${q.conversation_id}` }, 'Ver conversación') : null,
          q.status === 'sent' && isAdmin() ? h('button', { class: 'primary', onclick: () => acceptDialog(q, () => render()) }, 'El cliente aceptó') : null)),
      h('p', { class: 'small muted' }, `Creada ${fmtDate(q.created_at)} · Vigente hasta ${q.valid_until}`, q.source === 'bot' ? ' · Preparada por el asistente' : ''),
      Object.keys(q.customer_snapshot || {}).length
        ? h('dl', { class: 'small' }, Object.entries(q.customer_snapshot).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Concepto'), h('th', {}, 'Cantidad'), h('th', {}, 'Precio'), h('th', {}, 'Importe'))),
        h('tbody', {}, (q.lines || []).map((l) => h('tr', {},
          h('td', {}, l.name, l.edited_by_team ? h('span', { class: 'small muted' }, ' (editado por el equipo)') : null),
          h('td', {}, `${l.qty} ${l.unit}`),
          h('td', {}, unitPrice(l, c)),
          h('td', {}, lineAmount(l, c)))))),
      h('p', {}, h('strong', {}, `Total: ${totalText(q)}`), h('span', { class: 'small muted' }, ` (IVA ${Math.round(q.iva_rate * 100)} %)`)),
      q.notes ? h('p', { class: 'small' }, `Notas: ${q.notes}`) : null,
      q.rejected_reason ? h('p', { class: 'small' }, `Motivo del rechazo: ${q.rejected_reason}`) : null,
      q.status === 'accepted' ? h('p', { class: 'small' }, `Aceptada por el cliente${q.accepted_at ? ` el ${fmtDate(q.accepted_at)}` : ''}. `, h('a', { href: `#/cobros?status=` }, 'Ver sus cobros')) : null),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Historial'),
      h('ul', { class: 'small' }, (q.events || []).map((e) => h('li', {}, `${fmtDate(e.created_at)} · ${EVENT[e.type] || e.type}${e.user_name ? ` · ${e.user_name}` : ''}`)))));
}

const EVENT = {
  created: 'Creada', edited: 'Editada por el equipo', pending_approval: 'Enviada a aprobación', approved: 'Aprobada', sent: 'Enviada al cliente',
  rejected: 'Rechazada', expired: 'Venció', failed: 'No se pudo generar o enviar', draft: 'Vuelve a preparación', accepted: 'El cliente la aceptó',
};

/* ------------------------------ Aceptada por el cliente ------------------------------ */

const isoDay = (d) => d.toISOString().slice(0, 10);
const plusDays = (s, n) => isoDay(new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400_000));
function plusMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = m - 1 + n; const ny = y + Math.floor(t / 12); const nm = (t % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Los cobros que saldrán del plan (el servidor hace el mismo cálculo y lo valida). */
export function previewCharges(total, p) {
  if (!(total > 0)) return [];
  if (p.type === 'full') return [{ amount: total, due: p.due_date, label: 'Total' }];
  if (p.type === 'deposit') {
    const dep = Math.round((total * Number(p.percent)) / 100);
    return [{ amount: dep, due: p.due_date, label: `Anticipo (${p.percent} %)` }, { amount: total - dep, due: p.rest_due_date, label: 'Resto' }];
  }
  const n = Number(p.count); if (!(n >= 2)) return [];
  const each = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => ({
    amount: i === n - 1 ? total - each * (n - 1) : each,
    due: p.every === 'month' ? plusMonths(p.first_due, i) : plusDays(p.first_due, i * (p.every === 'week' ? 7 : 15)),
    label: `Pago ${i + 1} de ${n}`,
  }));
}

/** «El cliente aceptó»: se marca la cotización y, si se quiere, se crean sus cobros con sus recordatorios de pago. */
export async function acceptDialog(q, reload) {
  const c = q.currency;
  const exact = q.total_min === q.total_max && !q.open_ended && !q.has_tbd;
  const today = isoDay(new Date());
  const m = { amount: exact ? '' : (q.total_max ? (q.total_max / 100).toFixed(2) : ''), how: 'full', percent: '50', due_date: plusDays(today, 3), rest_due_date: plusDays(today, 30), count: '3', every: 'month', first_due: plusDays(today, 3) };
  const total = () => (exact ? q.total_max : Math.round(Number(m.amount) * 100));
  const plan = () => (m.how === 'none' ? null
    : m.how === 'full' ? { type: 'full', due_date: m.due_date }
      : m.how === 'deposit' ? { type: 'deposit', percent: Number(m.percent), due_date: m.due_date, rest_due_date: m.rest_due_date }
        : { type: 'installments', count: Number(m.count), every: m.every, first_due: m.first_due });
  const preview = h('div', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const opts = h('div');
  const date = (key, label) => field(label, h('input', { type: 'date', value: m[key], oninput: (e) => { m[key] = e.target.value; showPreview(); } }));
  const showPreview = () => {
    const p = plan();
    const list = p ? previewCharges(total(), p) : [];
    fill(preview, !p ? h('p', { class: 'muted' }, 'Solo se marca como aceptada; los cobros los registras tú después.')
      : !list.length ? h('p', { class: 'muted' }, 'Escribe el monto para ver los cobros.')
        : h('ul', { style: 'margin:4px 0' }, list.map((x) => h('li', {}, `${x.label}: ${money(x.amount, c)} · vence ${x.due}`))));
  };
  const drawOpts = () => {
    fill(opts,
      m.how === 'full' ? date('due_date', 'Vence') : null,
      m.how === 'deposit' ? h('div', { class: 'grid' },
        field('Anticipo (%)', h('input', { type: 'number', min: 1, max: 99, value: m.percent, oninput: (e) => { m.percent = e.target.value; showPreview(); } })),
        date('due_date', 'Vence el anticipo'), date('rest_due_date', 'Vence el resto')) : null,
      m.how === 'installments' ? h('div', { class: 'grid' },
        field('Número de pagos', h('input', { type: 'number', min: 2, max: 36, value: m.count, oninput: (e) => { m.count = e.target.value; showPreview(); } })),
        field('Cada', select(m, 'every', [['month', 'Mes'], ['fortnight', '15 días'], ['week', 'Semana']], showPreview)),
        date('first_due', 'Vence el primero')) : null);
    showPreview();
  };
  drawOpts();
  const content = h('div', {},
    h('p', {}, `Cotización ${q.folio} · ${totalText(q)}`),
    exact ? null : field('Monto final acordado', h('input', { type: 'number', min: 0.01, step: 0.01, value: m.amount, oninput: (e) => { m.amount = e.target.value; showPreview(); } }), 'La cotización es un rango o tiene conceptos por confirmar: escribe lo que se va a cobrar.'),
    field('Crear cobro', select(m, 'how', [['full', 'Un solo pago por el total'], ['deposit', 'Anticipo y resto'], ['installments', 'En parcialidades'], ['none', 'No crear cobro']], drawOpts)),
    opts, preview);
  const ok = await dialog('El cliente aceptó la cotización', content, 'Marcar aceptada', () => {
    if (m.how !== 'none' && !(total() > 0)) { toast('Escribe el monto final', true); return false; }
    return true;
  });
  if (!ok) return;
  const body = { plan: plan(), ...(!exact && total() > 0 ? { amount_cents: total() } : {}) };
  const r = await run(() => api('POST', `/api/quotes/${q.id}/accept`, body));
  if (!r) return;
  toast(r.receivables.length ? `Cotización aceptada: ${r.receivables.length} cobro(s) creado(s) con sus recordatorios` : 'Cotización marcada como aceptada');
  reload();
}

/* ------------------------------ En la conversación ------------------------------ */

/** Cotizaciones de una conversación: las por aprobar (o con error) se revisan, corrigen y envían desde aquí. */
export function quotesCard(quotes, reload) {
  if (!quotes?.length) return null;
  const open = quotes.some((q) => ['pending_approval', 'failed'].includes(q.status));
  return h('details', { class: 'card small', id: 'conversation-quotes', open },
    h('summary', {}, `Cotizaciones (${quotes.length})${open ? ' · por revisar' : ''}`),
    quotes.map((q) => quoteItem(q, reload)));
}

function quoteItem(q, reload) {
  const admin = isAdmin();
  const head = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;align-items:center' },
    h('strong', {}, q.folio), badge(KIND[q.kind]), badge(STATUS[q.status] || ['', q.status]), h('span', {}, totalText(q)),
    admin && q.pdf_path ? h('a', { href: `/api/quotes/${q.id}/file`, target: '_blank', rel: 'noopener' }, 'Ver PDF') : null,
    admin ? h('a', { href: `#/cotizaciones/historial?id=${q.id}` }, 'Detalle') : null,
    admin && q.status === 'sent' ? h('button', { class: 'small', onclick: () => acceptDialog(q, reload) }, 'El cliente aceptó') : null);
  if (!admin || !['pending_approval', 'failed'].includes(q.status)) return h('div', { class: 'quote-item', style: 'margin:8px 0' }, head);
  return h('div', { class: 'quote-item card', style: 'margin:8px 0;padding:10px' }, head, quoteEditor(q, reload));
}

/** Conceptos editables (cantidad y precio), notas y las acciones: guardar, aprobar y enviar, rechazar. */
function quoteEditor(q, reload) {
  const lines = (q.lines || []).map((l) => ({ ...l, min: toPesos(l.price_min), max: toPesos(l.price_max) }));
  const m = { notes: q.notes || '', kind: q.kind };
  let dirty = false;
  const touch = () => { dirty = true; };
  const box = h('div');
  const draw = () => fill(box,
    h('table', { class: 'quote-lines' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Concepto'), h('th', {}, 'Cantidad'), h('th', {}, 'Precio'), h('th', {}, ''))),
      h('tbody', {}, lines.map((l, i) => h('tr', {},
        h('td', {}, text(l, 'name', { 'aria-label': `Concepto ${i + 1}`, maxlength: 200, oninput: touch })),
        h('td', {}, text(l, 'qty', { type: 'number', min: 0.001, step: 'any', 'aria-label': `Cantidad de ${l.name}`, oninput: touch, style: 'max-width:90px' })),
        h('td', {}, h('div', { class: 'row', style: 'gap:4px' },
          named(select(l, 'price_mode', Object.entries(PRICE_MODE), () => { touch(); draw(); }), `Tipo de precio de ${l.name || `concepto ${i + 1}`}`),
          l.price_mode === 'tbd' ? null : text(l, 'min', { type: 'number', min: 0, step: '0.01', 'aria-label': `${l.price_mode === 'range' ? 'Mínimo' : 'Precio'} de ${l.name}`, oninput: touch, style: 'max-width:110px' }),
          l.price_mode === 'range' ? text(l, 'max', { type: 'number', min: 0, step: '0.01', 'aria-label': `Máximo de ${l.name}`, oninput: touch, style: 'max-width:110px' }) : null)),
        h('td', {}, lines.length > 1 ? h('button', { class: 'small', 'aria-label': `Quitar ${l.name}`, onclick: () => { lines.splice(i, 1); touch(); draw(); } }, 'Quitar') : null))))),
    h('div', { class: 'row', style: 'gap:6px' },
      h('button', { class: 'small', onclick: async () => {
        const items = await api('GET', `/api/price-items?account_id=${q.account_id}&active=1`).catch(() => []);
        const pick = { id: '' };
        const ok = await dialog('Agregar concepto', field('Concepto', select(pick, 'id', [['', 'Concepto libre (escribe nombre y precio)'], ...items.map((i) => [i.id, `${i.name} · ${unitPrice(i, q.currency)}`])])), 'Agregar');
        if (!ok) return;
        const it = items.find((i) => i.id === pick.id);
        lines.push(it
          ? { price_item_id: it.id, code: it.code, name: it.name, description: it.description, unit: it.unit, qty: 1, price_mode: it.price_mode, min: toPesos(it.price_min), max: toPesos(it.price_max), iva_mode: it.iva_mode }
          : { price_item_id: null, code: '', name: 'Concepto', description: '', unit: 'servicio', qty: 1, price_mode: 'exact', min: '', max: '', iva_mode: 'plus' });
        touch(); draw();
      } }, '+ Concepto'),
      field('Tipo', select(m, 'kind', [['final', 'Final'], ['approximate', 'Aproximada']], touch))),
    field('Notas en la cotización', area(m, 'notes', { maxlength: 2000, oninput: touch })));
  draw();
  const body = () => ({
    kind: m.kind, notes: m.notes,
    lines: lines.map((l) => ({
      price_item_id: l.price_item_id || null, code: l.code || '', name: l.name, description: l.description || '', unit: l.unit || 'servicio', qty: Number(l.qty),
      price_mode: l.price_mode, price_min: l.price_mode === 'tbd' ? null : toCents(l.min), price_max: l.price_mode === 'range' ? toCents(l.max) : null, iva_mode: l.iva_mode || 'plus',
    })),
  });
  const save = async () => { await api('PATCH', `/api/quotes/${q.id}`, body()); dirty = false; };
  const approve = async () => {
    const what = m.kind === 'final' ? 'COTIZACIÓN FINAL' : 'COTIZACIÓN APROXIMADA';
    if (!(await confirmAction(`Se enviará al cliente el PDF como ${what}, con su total. ¿Continuar?`))) return;
    if (await run(async () => { if (dirty) await save(); return api('POST', `/api/quotes/${q.id}/approve`); }, 'Cotización enviada al cliente')) reload();
  };
  const reject = async () => {
    const r = { reason: '', message: '' };
    const ok = await dialog('Rechazar cotización', h('div', {},
      field('Motivo (interno)', area(r, 'reason', { maxlength: 500 })),
      field('Mensaje al cliente (opcional)', area(r, 'message', { maxlength: 1000, placeholder: 'Por ahora no podemos confirmar esa cotización; te contactamos para revisar los detalles.' }), 'Si lo dejas vacío, el cliente no recibe nada.')), 'Rechazar');
    if (ok && (await run(() => api('POST', `/api/quotes/${q.id}/reject`, r), 'Cotización rechazada'))) reload();
  };
  return h('div', {},
    box,
    h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
      h('button', { class: 'small', onclick: async () => { if (await run(save, 'Cambios guardados')) reload(); } }, 'Guardar cambios'),
      h('button', { class: 'small primary', onclick: approve }, q.status === 'failed' ? 'Reintentar envío' : 'Aprobar y enviar'),
      q.status === 'pending_approval' ? h('button', { class: 'small danger', onclick: reject }, 'Rechazar') : null));
}
