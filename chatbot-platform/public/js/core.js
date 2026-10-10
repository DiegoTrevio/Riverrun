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
    const msg = data?.issues ? `${data.error}: ${data.issues.join('; ')}` : data?.error || `Error ${res.status}`;
    const error = new Error(msg);
    error.status = res.status;
    error.issues = data?.issues;
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

export function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.setAttribute('role', error ? 'alert' : 'status');
  t.setAttribute('aria-live', error ? 'assertive' : 'polite');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 2500);
}

export async function run(fn, okMsg) {
  const target = document.activeElement?.closest('.card');
  target?.querySelector(':scope > .form-error')?.remove();
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r === null || r === undefined ? { ok: true } : r;
  } catch (e) {
    if (target?.isConnected) {
      const box = h('div', { class: 'form-error banner danger', role: 'alert', tabindex: '-1' }, h('p', {}, e.issues ? 'Revisa los datos del formulario y vuelve a intentarlo.' : e.message || 'No se completó la acción.'), e.issues ? h('details', {}, h('summary', {}, 'Ver campos que necesitan revisión'), h('ul', {}, e.issues.map((issue) => h('li', {}, issue)))) : null);
      target.append(box);
      box.focus({ preventScroll: true });
    }
    toast(e.message || String(e), true);
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
    const part = h('span', { class: 'sr-only', id: `${id}-${i}` }, control.type === 'number' ? 'Cantidad' : control.tagName === 'SELECT' ? 'Opción' : control.type === 'file' ? 'Archivo' : `Dato ${i + 1}`);
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
    type: 'number', step: opts.step ?? 1, min: opts.min, max: opts.max, value: obj[key] ?? '',
    placeholder: opts.placeholder,
    oninput: (e) => (obj[key] = e.target.value === '' ? (opts.nullable ? null : 0) : Number(e.target.value)),
  });
}

export function select(obj, key, options, onchange) {
  return h('select', { name: key, 'data-auto-label': '1', 'aria-label': key.replace(/_/g, ' '), onchange: (e) => { obj[key] = e.target.value; onchange?.(e.target.value); } },
    options.map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l)));
}

export function check(obj, key, label) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => (obj[key] = e.target.checked) }), label);
}

/** Lista de textos, uno por renglón. */
export function lines(obj, key, opts = {}) {
  return h('textarea', {
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
    const close = (ok) => { if (closed) return; closed = true; box.close(); box.remove(); if (previous?.isConnected) previous.focus(); resolve(ok); };
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
export const confirmAction = (message) => dialog('Confirma la acción', h('p', {}, message));
