// Panel de administración — JavaScript sin dependencias ni build.

export const $app = document.getElementById('app');

export const state = { meta: null, me: null, accounts: [], bots: [], timers: [], accountId: '', navigation: 0, timeZone: '', ux: [] };
/** Datos agregados de esta sesión; sin URL/IDs, mensajes, prompts ni credenciales. */
export function recordUX(task, duration, outcome) {
  const entry = { task, duration_ms: Math.round(duration), outcome, role: state.me?.user?.role || 'public' };
  state.ux.push(entry);
  if (state.ux.length > 200) state.ux.shift();
  window.dispatchEvent(new CustomEvent('riverrun:ux', { detail: entry }));
}

try { state.accountId = localStorage.getItem('cp-account') || ''; } catch { /* sin storage */ }

/* ------------------------------ Utilidades ------------------------------ */

const reads = new Map();
const pendingReads = new Map();
let readVersion = 0;
export function invalidateReads() { reads.clear(); pendingReads.clear(); readVersion++; }

export async function api(method, url, body, isForm = false) {
  // Solo catálogos breves; sesión, permisos y conversaciones siempre se verifican.
  const cacheable = method === 'GET' && /^\/api\/(meta$|channels(?:\?|$))/.test(url);
  const key = `${state.me?.user?.id || 'public'}:${state.me?.user?.role || ''}:${state.accountId}:${url}`;
  const ttl = url === '/api/meta' ? 300000 : 1000;
  if (cacheable && reads.get(key)?.until > Date.now()) return clone(reads.get(key).data);
  if (cacheable && pendingReads.has(key)) return clone(await pendingReads.get(key));
  if (method !== 'GET') invalidateReads();
  const version = readVersion;
  const request = requestApi(method, url, body, isForm);
  if (cacheable) pendingReads.set(key, request);
  try {
    const data = await request;
    if (cacheable && version === readVersion) reads.set(key, { data, until: Date.now() + ttl });
    return cacheable ? clone(data) : data;
  } finally { if (pendingReads.get(key) === request) pendingReads.delete(key); }
}

async function requestApi(method, url, body, isForm) {
  const start = performance.now();
  const group = new URL(url, location.origin).pathname.split('/')[2] || 'other';
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  let res;
  try { res = await fetch(url, opts); }
  catch (error) { recordUX(`${method}:${group}`, performance.now() - start, 'network_error'); throw new Error('No pudimos conectar con el servidor. Conserva tus cambios e inténtalo de nuevo.'); }
  let data = null;
  try { data = await res.json(); } catch { /* vacío */ }
  recordUX(`${method}:${group}`, performance.now() - start, res.ok ? 'ok' : `http_${res.status}`);
  if (res.status === 401 && !url.endsWith('/login')) { location.hash = '#/login'; throw new Error('Sesión expirada'); }
  if (!res.ok) {
    // Un límite del plan no es un error de los datos: el mensaje ya dice qué pasó y a qué plan subir.
    const limited = data?.issues?.includes('limit_reached');
    const msg = data?.issues && !limited ? `${data.error}: ${data.issues.join('; ')}` : data?.error || `Error ${res.status}`;
    const error = new Error(msg);
    error.status = res.status;
    error.issues = data?.issues;
    if (limited) error.limit = data.limit || {};
    throw error;
  }
  return data;
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  // append() de los elementos que crea h() ignora null/false y aplana listas (igual que los hijos de h()); así
  // `root.append(cond ? x : null, ...lista)` nunca escribe "null" ni "[object HTMLDivElement]" en la pantalla.
  el.append = (...kids) => Element.prototype.append.call(el, ...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : String(c))));
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), (event) => {
      if (tag === 'tr' && k === 'onclick' && event.target.closest('a,button,input,select,textarea')) return;
      try { const result = v(event); result?.catch?.((error) => { if (el.isConnected) run(() => { throw error; }); }); }
      catch (error) { if (el.isConnected) run(() => { throw error; }); }
    });
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (tag === 'table') tableLabels(el);
  if (tag === 'tr' && props.onclick && !el.querySelector('a')) {
    const cell = [...el.children].find((td) => td.textContent.trim().length > 2 && !td.querySelector('button,input,select'));
    if (cell) { const button = h('button', { class: 'row-link', onclick: (e) => { e.stopPropagation(); props.onclick(e); } }); button.append(...cell.childNodes); cell.append(button); }
  }
  return el;
}

/** Reemplaza los hijos de un elemento ignorando null/false (igual que h()). */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))));
  if (el.tagName === 'TBODY') tableLabels(el.closest('table'));
}

function tableLabels(table) {
  if (!table) return;
  const labels = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
  if (!labels.length) return;
  table.classList.add('responsive-table');
  table.querySelectorAll('tbody tr').forEach((row) => [...row.children].forEach((cell, i) => {
    if (cell.colSpan !== 1) return;
    cell.dataset.label = labels[i] || '';
    cell.querySelectorAll('input,select,textarea').forEach((control) => { if (!control.closest('label') && !control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')) control.setAttribute('aria-label', `${labels[i]} · ${row.children[0]?.textContent || 'Fila'}`); });
  }));
}

let toastTimer;
let toastFrame;

/**
 * Avisos en dos regiones fijas de index.html (#toast con role=status y #toast-alert con role=alert): el lector ya las
 * conoce cuando cambia su texto. Con un diálogo abierto se mueven dentro de él: fuera quedarían debajo y sin anunciarse.
 */
export function toast(msg, error = false) {
  // Si un diálogo propio se borró con las regiones dentro, se vuelven a crear.
  const regions = [['toast', 'status'], ['toast-alert', 'alert']].map(([id, role]) => document.getElementById(id)
    || h('div', { id, class: `toast${role === 'alert' ? ' error' : ''}`, role, 'aria-atomic': 'true' }));
  for (const r of regions) r.textContent = '';
  const t = regions[error ? 1 : 0];
  clearTimeout(toastTimer); cancelAnimationFrame(toastFrame);
  // El lugar se decide en el siguiente cuadro: un «Guardado» seguido de cerrar el diálogo sale en la página, no se pierde.
  toastFrame = requestAnimationFrame(() => {
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    for (const r of regions) if (r.parentNode !== host) host.append(r);
    t.textContent = msg;
  });
  toastTimer = setTimeout(() => { t.textContent = ''; }, error ? 6000 : 2500);
}
/** Al cerrar un diálogo, los avisos vuelven a la página. */
function restoreToasts() {
  for (const id of ['toast', 'toast-alert']) { const r = document.getElementById(id); if (r && r.parentNode !== document.body) document.body.append(r); }
}

/**
 * Errores del servidor ("campo: mensaje") junto a su campo: aria-invalid, el mensaje en aria-describedby (sin quitar la
 * ayuda) y el foco en el primero. El campo se busca por name o data-field (la ruta completa o su primera parte).
 * Devuelve los errores que no encontraron campo.
 */
export function showFieldErrors(scope, issues = []) {
  clearFieldErrors(scope);
  const loose = [];
  let first = null;
  for (const issue of issues) {
    const [path, ...rest] = String(issue).split(': ');
    const message = rest.join(': ');
    // Primero la ruta completa y luego su primera parte (un campo anidado sin control propio va a su grupo).
    const find = (n) => scope.querySelector(`[name="${CSS.escape(n)}"]:not([type=hidden]),[data-field="${CSS.escape(n)}"]`);
    const control = message ? find(path) || (path.includes('.') ? find(path.split('.')[0]) : null) : null;
    if (!control) { loose.push(issue); continue; }
    markFieldError(control, message);
    first ||= control;
  }
  first?.focus();
  return loose;
}

function markFieldError(control, message) {
  if (!control.id) control.id = `field-${++fieldId}`;
  const id = `${control.id}-error`;
  let note = document.getElementById(id);
  if (!note) {
    note = h('small', { class: 'field-error', id });
    // Dentro de su campo; nunca dentro de la etiqueta de una casilla (se volvería parte de su nombre).
    const box = control.closest('.field');
    if (box) box.append(note); else (control.closest('label') || control).after(note);
  }
  note.textContent = message;
  if (!('describedby' in control.dataset)) control.dataset.describedby = control.getAttribute('aria-describedby') || '';
  control.setAttribute('aria-describedby', [control.dataset.describedby, id].filter(Boolean).join(' '));
  control.setAttribute('aria-invalid', 'true');
  const clear = () => clearFieldError(control);
  control.addEventListener('input', clear, { once: true });
  control.addEventListener('change', clear, { once: true });
}

function clearFieldError(control) {
  document.getElementById(`${control.id}-error`)?.remove();
  control.removeAttribute('aria-invalid');
  if ('describedby' in control.dataset) {
    const original = control.dataset.describedby;
    if (original) control.setAttribute('aria-describedby', original); else control.removeAttribute('aria-describedby');
    delete control.dataset.describedby;
  }
}

export function clearFieldErrors(scope) { scope?.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError); }

const amountText = (n) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);

/**
 * Se topó un límite del plan: en lugar de "revisa el formulario", qué se topó y un botón para subir al plan que alcanza
 * (lo deja elegido en Mi plan). Quien no administra la cuenta ve a quién pedírselo.
 */
export function upgradeCard(e) {
  const l = e.limit || {};
  const p = l.next_plan;
  const canPay = ['admin', 'superadmin'].includes(state.me?.user?.role);
  return h('div', { class: 'form-error banner warn', role: 'alert', tabindex: '-1' },
    h('p', {}, h('strong', {}, l.label ? `Llegaste al límite de ${l.label} de tu plan` : 'Llegaste al límite de tu plan'), l.max ? ` (${l.used} de ${l.max}).` : '.'),
    !canPay
      ? h('p', {}, 'Pídele a un administrador de tu cuenta que cambie de plan en Mi plan y pagos.')
      : p
        ? h('p', {}, h('a', { class: 'btn primary', href: `#/plan?subir=${encodeURIComponent(p.key)}` }, `Subir a ${p.name}`), ` $${amountText(p.price)} ${p.currency} al ${p.interval === 'year' ? 'año' : 'mes'}${p.total !== p.price ? ' + IVA' : ''} · `,
          p.allows ? `hasta ${p.allows.toLocaleString('es-MX')} ${l.label}` : `${l.label} sin límite`)
        : h('p', {}, h('a', { class: 'btn primary', href: '#/plan' }, 'Ver planes')));
}

export async function run(fn, okMsg) {
  const target = document.activeElement?.closest('.card');
  target?.querySelector(':scope > .form-error')?.remove();
  clearFieldErrors(target);
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r === null || r === undefined ? { ok: true } : r;
  } catch (e) {
    if (!target?.isConnected) { toast(e.message || String(e), true); return undefined; }
    // Cada error va junto a su campo (y el foco al primero); en la tarjeta solo quedan los que no tienen campo. Un solo
    // aviso: la tarjeta lo anuncia, sin repetirlo abajo en el aviso emergente.
    const loose = e.issues && !e.limit ? showFieldErrors(target, e.issues) : null;
    const marked = !!loose && loose.length < e.issues.length;
    const box = e.limit
      ? upgradeCard(e)
      : h('div', { class: 'form-error banner danger', role: 'alert', tabindex: '-1' },
        h('p', {}, e.issues ? (marked ? 'Revisa los campos marcados.' : 'Revisa los datos del formulario y vuelve a intentarlo.') : e.message || 'No se completó la acción.'),
        loose?.length ? h('ul', {}, loose.map((issue) => h('li', {}, issue))) : null);
    target.append(box);
    if (!marked) { box.focus({ preventScroll: true }); box.scrollIntoView?.({ block: 'nearest' }); }
    return undefined;
  }
}

export const fmtDate = (d, timeZone = state.timeZone) => (d ? new Date(d).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }) : '');
export function localDateTime(d, timeZone) {
  if (!d) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------ Personas, tiempos y teléfonos ------------------------------ */
/** Iniciales de una persona (dos letras como máximo). */
export const initialsOf = (name) => (name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
/** Tono estable de cada persona (identidad, no dato): tintes pálidos separados, nunca violeta. */
const PERSON_HUES = [190, 32, 140, 350, 205, 85, 12, 165];
export const personTint = (key) => `--h:${PERSON_HUES[[...String(key || '?')].reduce((n, ch) => n + ch.charCodeAt(0), 0) % PERSON_HUES.length]}`;
/** «hace 4 min», «hace 2 h», «ayer»… para lo que espera o acaba de pasar. */
export function ago(d) {
  if (!d) return '';
  const mins = Math.max(0, (Date.now() - new Date(d)) / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${Math.round(mins)} min`;
  if (mins < 24 * 60) return `hace ${Math.round(mins / 60)} h`;
  const days = Math.round(mins / 1440);
  return days === 1 ? 'ayer' : `hace ${days} días`;
}
/** Número de WhatsApp legible: +52 998 123 4567 (México) o +lada y el resto. */
export function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  const m = d.match(/^52(1?)(\d{3})(\d{3})(\d{4})$/);
  if (m) return `+52 ${m[2]} ${m[3]} ${m[4]}`; // el «1» de los celulares es del identificador de WhatsApp, no del número
  return `+${d}`;
}

/* ------------------------------ Campos de formulario ------------------------------ */

export function field(label, input, help) {
  const controls = input.matches?.('input,textarea,select') ? [input] : [...(input.querySelectorAll?.('input,textarea,select') || [])];
  const id = `field-${++fieldId}`;
  const title = h('span', { id: `${id}-label` }, label);
  const hint = help ? h('small', { id: `${id}-help` }, help) : null;
  if (controls.length === 1) {
    const c = controls[0];
    if (!c.id) c.id = id;
    if (c.dataset.autoLabel) c.removeAttribute('aria-label');
    title.id = `${id}-label`;
    c.setAttribute('aria-labelledby', title.id);
    if (hint) c.setAttribute('aria-describedby', hint.id);
    return h('label', { class: 'field', for: c.id }, title, input, hint);
  }
  const legend = h('legend', { id: `${id}-label` }, label);
  const names = [];
  controls.forEach((control, i) => {
    if (control.closest('label') || (control.hasAttribute('aria-labelledby') && !control.dataset.autoLabel)) return;
    // El nombre de cada parte sale de lo que el control ya dice (data-label, placeholder o title); solo sin nada de eso
    // queda una palabra genérica, marcada para que la prueba del panel la encuentre.
    const own = control.dataset.label || control.getAttribute('aria-label') || control.getAttribute('placeholder') || control.title;
    const generic = control.type === 'number' ? 'Cantidad' : control.tagName === 'SELECT' ? 'Opción' : control.type === 'file' ? 'Archivo' : 'Valor';
    const part = h('span', { class: 'sr-only', id: `${id}-${i}`, 'data-generic': own ? null : '1' }, own || generic);
    control.removeAttribute('aria-label');
    control.setAttribute('aria-labelledby', `${legend.id} ${part.id}`);
    if (hint) control.setAttribute('aria-describedby', hint.id);
    names.push(part);
  });
  return h('fieldset', { class: 'field', 'aria-describedby': hint?.id }, legend, input, names, hint);
}
let fieldId = 0;

export function text(obj, key, opts = {}) {
  return h('input', { ...opts, type: opts.type || 'text', name: key, value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; opts.oninput?.(e); } });
}

export function area(obj, key, opts = {}) {
  const { big, ...attrs } = opts;
  return h('textarea', { ...attrs, name: key, class: big ? 'big' : '', value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; opts.oninput?.(e); } });
}

export function num(obj, key, opts = {}) {
  return h('input', {
    type: 'number', name: key, step: opts.step ?? 1, min: opts.min, max: opts.max, value: obj[key] ?? '',
    placeholder: opts.placeholder,
    oninput: (e) => (obj[key] = e.target.value === '' ? (opts.nullable ? null : 0) : Number(e.target.value)),
  });
}

export function select(obj, key, options, onchange) {
  // Sin aria-label con la llave (en inglés): la etiqueta la da field() o quien lo usa suelto.
  return h('select', { name: key, 'data-auto-label': '1', onchange: (e) => { obj[key] = e.target.value; onchange?.(e.target.value); } },
    options.map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l)));
}

/** Nombre accesible de un control que va suelto (sin field()). */
export const named = (el, label) => { el.setAttribute('aria-label', label); return el; };

export function check(obj, key, label) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', name: key, checked: !!obj[key], onchange: (e) => (obj[key] = e.target.checked) }), label);
}

/** Lista de textos, uno por renglón. */
export function lines(obj, key, opts = {}) {
  return h('textarea', {
    name: key,
    class: opts.big ? 'big' : '',
    placeholder: opts.placeholder || 'Uno por renglón',
    value: (obj[key] || []).join('\n'),
    oninput: (e) => (obj[key] = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)),
  });
}

/** Sondeo visible, sin solapamientos; los workers del servidor no dependen de él. */
export function poll(fn, ms, root) {
  const nav = state.navigation;
  let busy = false;
  let failures = 0;
  let next = 0;
  const tick = async () => {
    if (nav !== state.navigation || (root && !root.isConnected)) { clearInterval(timer); return; }
    if (document.hidden || busy || Date.now() < next) return;
    busy = true;
    try { await fn(); failures = 0; }
    catch { failures++; }
    finally { busy = false; next = Date.now() + Math.min(ms * 2 ** failures, 60000); }
  };
  const timer = setInterval(tick, ms);
  const visible = () => { if (!document.hidden) { next = 0; tick(); } };
  document.addEventListener('visibilitychange', visible);
  state.timers.push(timer, () => document.removeEventListener('visibilitychange', visible));
  return timer;
}

export function errorCard(error, retry) {
  return h('div', { class: 'card banner danger', role: 'alert' }, h('h2', {}, 'No pudimos completar esta acción'), h('p', {}, error.message || 'Revisa tu conexión e inténtalo de nuevo.'), retry ? h('button', { onclick: retry }, 'Reintentar') : null);
}

/** Diálogo nativo compartido: cancelación, Escape y retorno de foco. */
export function dialog(title, content, accept = 'Continuar', validate = () => true) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const titleId = `dialog-${++fieldId}`;
    const box = h('dialog', { class: 'card app-dialog', 'aria-labelledby': titleId });
    let closed = false;
    const close = (ok) => { if (closed) return; closed = true; box.close(); restoreToasts(); box.remove(); if (previous?.isConnected) previous.focus(); resolve(ok); };
    box.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    box.append(h('h2', { id: titleId }, title), content, h('div', { class: 'row dialog-actions' }, h('button', { onclick: () => close(false) }, 'Cancelar'), h('button', { class: 'primary', onclick: () => { if (validate()) close(true); } }, accept)));
    document.body.append(box); box.showModal();
  });
}

export async function ask(message, value = '', opts = {}) {
  const input = h('input', { type: opts.type || 'text', value, autocomplete: opts.type === 'password' ? 'new-password' : 'off', minlength: opts.minlength, required: opts.required });
  const accepted = await dialog(opts.title || 'Completa la información', field(message, input), opts.accept || 'Guardar', () => input.reportValidity());
  return accepted ? input.value : null;
}
export const confirmAction = (message, accept) => dialog('Confirma la acción', h('p', {}, message), accept);
