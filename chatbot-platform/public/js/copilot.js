// Copiloto: panel lateral desde el que se le pide al Copiloto lo que se necesita. Vive fuera de #app (navegar no lo
// borra), tiene sus propios temporizadores (la navegación limpia los del panel) y sabe qué página está abierta.
import { api, h, fill, invalidateReads, state, toast } from './core.js';
import { copilotAvailable, isAdmin, withAcct } from './session.js';
import { icon } from './icons.js';
import { actionCard, readsGroup, renderText } from './copilot-cards.js';

const KEY = 'cp-copilot';
const dock = window.matchMedia('(min-width: 1280px)');
const phone = window.matchMedia('(max-width: 768px)');

const s = {
  mounted: false, open: false, view: 'chat', threadId: '', accountId: '',
  messages: new Map(), actions: new Map(), turn: null, rev: 0,
  refs: [], pageOff: false, pageHash: '', pageLabel: '', busy: new Set(), timer: 0, sending: false,
};
const el = {};

function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify({ open: s.open, threadId: s.threadId, accountId: s.accountId })); } catch { /* almacenamiento opcional */ }
}
function restore() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

const url = (path) => withAcct(`/api/copilot${path}`);

// --- Montaje -------------------------------------------------------------------------------------------------------

function build() {
  el.status = h('p', { class: 'cp-status', role: 'status', 'aria-live': 'polite' });
  el.body = h('div', { class: 'cp-body' });
  el.refresh = h('div', { class: 'cp-refresh', hidden: true },
    h('span', {}, 'Cambió algo de esta página.'),
    h('button', { type: 'button', class: 'small', onclick: refreshView }, 'Actualizar vista'));
  el.input = h('textarea', { id: 'copilot-input', rows: '2', maxlength: '4000', placeholder: 'Pídeme lo que necesites…', 'aria-label': 'Qué necesitas del Copiloto', onkeydown: onKey });
  el.chips = h('div', { class: 'cp-chips' });
  el.send = h('button', { type: 'submit', class: 'primary', 'aria-label': 'Enviar al Copiloto' }, icon('send', 16), h('span', {}, 'Enviar'));
  el.stop = h('button', { type: 'button', class: 'cp-stop', hidden: true, onclick: stopTurn }, 'Detener');
  el.form = h('form', { class: 'cp-composer', onsubmit: (e) => { e.preventDefault(); return send(); } },
    el.chips, el.input, h('div', { class: 'cp-composer-bar' }, h('span', { class: 'help cp-hint' }, 'Enter envía · Mayús+Enter, otro renglón'), el.stop, el.send));
  el.root = h('aside', { id: 'copilot', class: 'copilot', 'aria-labelledby': 'copilot-title', hidden: true, onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeCopilot(); } } },
    h('header', { class: 'cp-head' },
      h('h2', { id: 'copilot-title' }, icon('wand', 18), 'Copiloto'),
      h('div', { class: 'cp-head-actions' },
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Conversaciones anteriores', title: 'Conversaciones anteriores', onclick: showThreads }, icon('list', 18)),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Nueva conversación con el Copiloto', title: 'Nueva conversación', onclick: newThread }, icon('plus', 18)),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Cerrar el Copiloto', title: 'Cerrar (Esc)', onclick: () => closeCopilot() }, icon('x', 18)))),
    el.refresh, el.body, el.status, el.form);
  document.body.append(el.root);
}

function onShortcut(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); toggleCopilot(); }
}

function mount() {
  if (s.mounted) return;
  build();
  s.mounted = true;
  const saved = restore();
  s.accountId = state.accountId;
  if (saved.accountId === s.accountId) s.threadId = saved.threadId || '';
  document.addEventListener('keydown', onShortcut);
  dock.addEventListener('change', layout);
  phone.addEventListener('change', layout);
  window.addEventListener('sessionended', unmount);
  if (saved.open && saved.accountId === s.accountId) openCopilot(false);
}

function unmount() {
  if (!s.mounted) return;
  clearTimeout(s.timer);
  closeCopilot(false);
  el.root.remove();
  document.removeEventListener('keydown', onShortcut);
  dock.removeEventListener('change', layout);
  phone.removeEventListener('change', layout);
  window.removeEventListener('sessionended', unmount);
  Object.assign(s, { mounted: false, threadId: '', messages: new Map(), actions: new Map(), turn: null, rev: 0, refs: [] });
}

/** Lo llama el panel después de cada vista: monta o quita el Copiloto y actualiza la página abierta. */
export function syncCopilot() {
  if (!copilotAvailable()) { unmount(); return; }
  mount();
  // El superadmin cambió de cuenta: los hilos son de cada cuenta.
  if (s.accountId !== state.accountId) { s.accountId = state.accountId; resetThread(); save(); if (s.open) render(); }
  const hash = location.hash || '#/';
  if (hash !== s.pageHash) { s.pageHash = hash; s.pageOff = false; el.refresh.hidden = true; }
  s.pageLabel = document.querySelector('#contenido h1')?.textContent?.trim() || '';
  syncLaunchers();
  if (s.open && s.view === 'chat') renderChips();
}

function syncLaunchers() {
  for (const b of document.querySelectorAll('[data-copilot-launcher]')) b.setAttribute('aria-expanded', String(s.open));
}

/** Acoplado (pantalla ancha), cajón encima (mediana) o pantalla completa (teléfono). */
function layout() {
  if (!s.mounted) return;
  const full = s.open && phone.matches;
  document.body.classList.toggle('cp-docked', s.open && dock.matches);
  document.body.classList.toggle('cp-open', s.open);
  if (full) { el.root.setAttribute('role', 'dialog'); el.root.setAttribute('aria-modal', 'true'); document.getElementById('app')?.setAttribute('inert', ''); }
  else { el.root.removeAttribute('role'); el.root.removeAttribute('aria-modal'); document.getElementById('app')?.removeAttribute('inert'); }
}

export function toggleCopilot() {
  if (!s.mounted) return;
  if (s.open) closeCopilot();
  else openCopilot();
}

async function openCopilot(focus = true) {
  s.open = true;
  el.root.hidden = false;
  layout(); syncLaunchers(); save();
  if (s.view === 'threads') await showThreads();
  else if (s.threadId) await loadThread(s.threadId);
  else render();
  if (focus) el.input.focus();
}

function closeCopilot(returnFocus = true) {
  if (!s.mounted) return;
  s.open = false;
  el.root.hidden = true;
  clearTimeout(s.timer);
  layout(); syncLaunchers(); save();
  // El foco vuelve al botón que se ve (en el teléfono el del menú lateral está escondido).
  if (returnFocus) [...document.querySelectorAll('[data-copilot-launcher]')].find(visible)?.focus();
}

const visible = (b) => (b.checkVisibility ? b.checkVisibility({ visibilityProperty: true }) : !!b.offsetParent);

// --- Datos ---------------------------------------------------------------------------------------------------------

function resetThread() {
  s.threadId = ''; s.messages = new Map(); s.actions = new Map(); s.turn = null; s.rev = 0; s.refs = [];
  clearTimeout(s.timer);
}

/** ¿El enlace es de la página que está abierta? (para ofrecer «Actualizar vista») */
function samePage(href) {
  const now = (location.hash || '#/').split('?')[0];
  return !!href && href.split('?')[0] === now;
}

/** `initial`: se abre un hilo guardado; lo que ya estaba hecho no es un cambio nuevo en la página. */
function merge(u, initial = false) {
  let touchedPage = false;
  for (const m of u.messages || []) s.messages.set(m.id, m);
  for (const a of u.actions || []) {
    const before = s.actions.get(a.id);
    s.actions.set(a.id, a);
    if (!initial && before?.status !== a.status && ['done', 'undone'].includes(a.status) && a.risk !== 'read') {
      invalidateReads();
      if ((a.links || []).some((l) => samePage(l.href))) touchedPage = true;
    }
  }
  for (const t of u.turns || []) if (t && (!s.turn || t.id === s.turn.id || new Date(t.started_at) >= new Date(s.turn.started_at))) s.turn = t;
  if (u.turn !== undefined) s.turn = u.turn;
  if (typeof u.rev === 'number') s.rev = Math.max(s.rev, u.rev);
  if (touchedPage) el.refresh.hidden = false;
}

async function loadThread(id) {
  try {
    const r = await api('GET', url(`/threads/${id}`));
    resetThread();
    s.threadId = id;
    merge(r, true);
    s.view = 'chat'; save();
    render();
    if (running()) schedule(800);
  } catch (e) {
    // El hilo ya no existe (o es de otra cuenta): se empieza uno nuevo.
    resetThread(); s.view = 'chat'; save(); render();
    if (e.status !== 404) setStatus(e.message, true);
  }
}

function running() {
  return s.turn?.status === 'running' || [...s.actions.values()].some((a) => a.status === 'executing' || a.status === 'undoing');
}

function schedule(ms = 1000) {
  clearTimeout(s.timer);
  s.timer = setTimeout(pull, document.hidden ? Math.max(ms, 4000) : ms);
}

async function pull() {
  if (!s.open || !s.threadId) return;
  try {
    const u = await api('GET', url(`/threads/${s.threadId}/updates?after_rev=${s.rev}`));
    const changed = (u.messages?.length || 0) + (u.actions?.length || 0) + (u.turns?.length || 0) > 0;
    merge(u);
    if (changed) render();
    if (running()) schedule(1000);
  } catch {
    schedule(4000);
  }
}

// --- Acciones de la persona ----------------------------------------------------------------------------------------

async function send() {
  const text = el.input.value.trim();
  if (!text || s.sending || running()) return;
  s.sending = true;
  el.send.disabled = true;
  try {
    if (!s.threadId) { const t = await api('POST', url('/threads'), {}); s.threadId = t.id; save(); }
    const r = await api('POST', url(`/threads/${s.threadId}/messages`), { text, page: { hash: s.pageOff ? '' : location.hash }, refs: s.refs.map((x) => x.id) });
    el.input.value = '';
    s.refs = []; s.pageOff = false;
    merge({ messages: [r.message], turns: [r.turn] });
    render();
    schedule(700);
  } catch (e) {
    setStatus(e.message || 'No se pudo enviar', true);
  } finally {
    s.sending = false;
    el.send.disabled = running();
  }
}

async function stopTurn() {
  if (!s.turn) return;
  try { await api('POST', url(`/turns/${s.turn.id}/stop`), {}); setStatus('Deteniendo…'); } catch (e) { setStatus(e.message, true); }
}

async function act(a, path, body, done) {
  s.busy.add(a.id); render();
  try {
    const updated = await api('POST', url(`/actions/${a.id}/${path}`), body || {});
    merge({ actions: [updated] });
    if (done) toast(done(updated), updated.status === 'failed');
    schedule(600);
  } catch (e) {
    toast(e.message || 'No se pudo', true);
    pull();
  } finally {
    s.busy.delete(a.id); render();
  }
}

const handlers = {
  confirm: (a) => act(a, 'confirm', { seen_hash: a.seen_hash }, (u) => (u.status === 'done' ? `Hecho: ${u.title}` : `No se pudo: ${u.error || u.title}`)),
  decline: (a) => act(a, 'decline', {}, () => 'Propuesta descartada'),
  undo: (a) => act(a, 'undo', {}, () => 'Se deshizo el cambio'),
  change: (a) => {
    if (!s.refs.some((r) => r.id === a.id)) s.refs = [...s.refs, { id: a.id, title: a.title }].slice(-5);
    renderChips();
    el.input.focus();
  },
  visit: () => { if (phone.matches) closeCopilot(false); },
};

async function undoTurn(turnId) {
  try {
    const r = await api('POST', url(`/turns/${turnId}/undo-all`), {});
    toast(r.failed.length ? `Se deshicieron ${r.undone.length}; ${r.failed.length} no se pudieron` : `Se deshicieron ${r.undone.length} cambios`, r.failed.length > 0);
  } catch (e) { toast(e.message, true); }
  pull();
}

function newThread() {
  resetThread(); s.view = 'chat'; save(); render(); el.input.focus();
}

async function showThreads() {
  s.view = 'threads';
  save();
  el.form.hidden = true;
  setStatus('');
  fill(el.body, h('p', { class: 'help cp-pad' }, 'Cargando conversaciones…'));
  try {
    const list = await api('GET', url('/threads'));
    fill(el.body, h('div', { class: 'cp-threads' },
      h('div', { class: 'row between cp-pad' }, h('h3', {}, 'Conversaciones'), h('button', { type: 'button', class: 'small', onclick: newThread }, icon('plus', 14), 'Nueva')),
      list.length
        ? h('ul', { class: 'cp-thread-list' }, list.map((t) => h('li', {}, h('button', { type: 'button', class: `cp-thread${t.id === s.threadId ? ' active' : ''}`, onclick: () => loadThread(t.id) },
          h('span', { class: 'cp-thread-title' }, t.title), h('span', { class: 'help' }, new Date(t.updated_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }))))))
        : h('p', { class: 'help cp-pad' }, 'Aún no hay conversaciones con el Copiloto.')));
  } catch (e) {
    fill(el.body, h('p', { class: 'cp-error cp-pad' }, e.message));
  }
}

function refreshView() {
  el.refresh.hidden = true;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
}

function setStatus(text, error = false) {
  el.status.textContent = text || '';
  el.status.classList.toggle('busy', !error && !!text && running());
  el.status.classList.toggle('err', error);
}

// --- Pintar --------------------------------------------------------------------------------------------------------

function examples() {
  const hash = location.hash;
  if (hash.startsWith('#/contact/')) return ['Etiqueta a este contacto como VIP', 'Déjame un pendiente para llamarle mañana', '¿Qué citas y cotizaciones tiene?'];
  if (hash.startsWith('#/conversation/')) return ['¿De qué trata esta conversación?', 'Asígnamela', 'Prepárale un mensaje para confirmar su cita'];
  if (!isAdmin()) return ['¿Qué conversaciones tengo sin responder?', 'Busca a Ana y dime sus pendientes'];
  if (hash.startsWith('#/bot/')) return ['Agrega a las instrucciones que no damos precios por mensaje', 'Haz que salude por su nombre'];
  if (hash.startsWith('#/automation')) return ['Crea un flujo que pida nombre y correo a quien escribe por primera vez', 'Pausa el flujo de bienvenida'];
  return ['¿Quién me escribió hoy y sigue sin respuesta?', 'Etiqueta como «frío» a los contactos sin actividad en 30 días', '¿Cuántas citas tengo esta semana?'];
}

function renderChips() {
  const chips = [];
  if (!s.pageOff && s.pageLabel) {
    chips.push(h('span', { class: 'cp-chip' }, h('span', { class: 'cp-chip-text' }, `En esta página: ${s.pageLabel}`),
      h('button', { type: 'button', class: 'cp-chip-x', 'aria-label': 'No usar esta página como contexto', onclick: () => { s.pageOff = true; renderChips(); } }, icon('x', 12))));
  }
  for (const r of s.refs) {
    chips.push(h('span', { class: 'cp-chip ref' }, h('span', { class: 'cp-chip-text' }, `Sobre: ${r.title}`),
      h('button', { type: 'button', class: 'cp-chip-x', 'aria-label': `Quitar la referencia a ${r.title}`, onclick: () => { s.refs = s.refs.filter((x) => x.id !== r.id); renderChips(); } }, icon('x', 12))));
  }
  fill(el.chips, chips);
}

/** Mensajes y acciones en orden; las consultas seguidas se juntan en «Consultó N cosas». */
function timeline() {
  const items = [
    ...[...s.messages.values()].map((m) => ({ kind: 'm', at: new Date(m.created_at).getTime(), order: m.id, m })),
    ...[...s.actions.values()].map((a) => ({ kind: 'a', at: new Date(a.created_at).getTime(), order: 0, a })),
  ].sort((x, y) => x.at - y.at || (x.kind === y.kind ? x.order - y.order : x.kind === 'm' ? -1 : 1));
  const undoable = new Map();
  for (const a of s.actions.values()) if (a.can_undo) undoable.set(a.turn_id, (undoable.get(a.turn_id) || 0) + 1);
  const out = [];
  let reads = [];
  const flush = () => { if (reads.length) out.push(readsGroup(reads)); reads = []; };
  for (const it of items) {
    if (it.kind === 'a' && it.a.risk === 'read') { reads.push(it.a); continue; }
    flush();
    if (it.kind === 'a') { out.push(actionCard(it.a, handlers, s.busy.has(it.a.id))); continue; }
    const m = it.m;
    if (m.role === 'user') {
      const refs = (m.refs || []).map((id) => s.actions.get(id)).filter(Boolean);
      out.push(h('div', { class: 'cp-msg is-user', 'data-key': `m:${m.id}` }, h('span', { class: 'sr-only' }, 'Tú: '), m.redacted ? '(mensaje borrado)' : m.content,
        refs.length ? h('div', { class: 'cp-msg-refs' }, refs.map((a) => h('span', { class: 'cp-chip ref' }, `Sobre: ${a.title}`))) : null));
    } else if (m.role === 'assistant') {
      const n = undoable.get(m.turn_id) || 0;
      const turnDone = !(s.turn?.id === m.turn_id && s.turn?.status === 'running');
      out.push(h('div', { class: 'cp-msg is-copilot', 'data-key': `m:${m.id}` }, h('span', { class: 'sr-only' }, 'Copiloto: '), renderText(m.content),
        n > 1 && turnDone ? h('div', { class: 'cp-msg-actions' }, h('button', { type: 'button', class: 'small', 'data-key': `undoall:${m.turn_id}`, onclick: () => undoTurn(m.turn_id) }, icon('undo', 14), `Deshacer los ${n} cambios`)) : null));
    } else if (m.role === 'event') {
      out.push(h('p', { class: 'cp-event', 'data-key': `m:${m.id}` }, m.content));
    }
  }
  flush();
  return out;
}

function render() {
  if (!s.mounted || !s.open || s.view === 'threads') return;
  el.form.hidden = false;
  const focusKey = el.root.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
  const log = el.body.querySelector('.cp-log');
  const atBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const items = timeline();
  const next = h('div', { class: 'cp-log', role: 'log', 'aria-label': 'Conversación con el Copiloto', tabindex: '0' },
    items.length ? items : h('div', { class: 'cp-empty' },
      h('p', {}, 'Dime qué quieres hacer y lo hago en el panel. Lo que se puede deshacer lo aplico al momento; lo que llega a tus clientes te lo muestro antes para que lo confirmes.'),
      h('div', { class: 'ai-examples' }, examples().map((x) => h('button', { type: 'button', class: 'ai-example', onclick: () => { el.input.value = x; el.input.focus(); } }, x)))));
  const keep = log ? log.scrollTop : 0;
  fill(el.body, next);
  next.scrollTop = atBottom ? next.scrollHeight : keep;
  if (focusKey) next.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  renderChips();
  const live = s.turn?.status === 'running';
  el.stop.hidden = !live;
  el.send.disabled = running() || s.sending;
  setStatus(live ? s.turn.step_label || 'Pensando…' : '');
}
