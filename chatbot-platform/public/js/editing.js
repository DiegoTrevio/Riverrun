import { h, state } from './core.js';

// Exclusivo de configuración del agente y creación. Nunca contactos, contraseñas, QR ni credenciales.
const drafts = new Map();
const prefix = () => `cp-draft:${state.me?.user.id}:${state.accountId}:`;
const storageKey = (key) => prefix() + key;
const encode = (value) => JSON.stringify(value);

export function draftModel(key, initial, persistent = true) {
  const id = storageKey(key);
  const base = encode(initial);
  let record = drafts.get(id);
  if (!record && persistent) {
    try {
      const saved = JSON.parse(localStorage.getItem(id) || 'null');
      if (saved && Date.now() - saved.at < 7 * 86400000) record = saved;
      else localStorage.removeItem(id);
    } catch { /* sin almacenamiento */ }
  }
  if (!record) record = { base, value: JSON.parse(base), at: Date.now() };
  record.persistent = persistent;
  record.serverBase ??= record.base;
  record.changedOnServer = record.serverBase !== base;
  drafts.set(id, record);
  const proxies = new WeakMap();
  const persist = () => {
    record.at = Date.now();
    if (persistent) { try { localStorage.setItem(id, encode(record)); } catch { /* memoria solamente */ } }
    window.dispatchEvent(new Event('draftchange'));
  };
  const wrap = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (proxies.has(obj)) return proxies.get(obj);
    const proxy = new Proxy(obj, {
      get: (target, key) => wrap(target[key]),
      set: (target, key, value) => { if (encode(target[key]) === encode(value)) return true; target[key] = value; if (!record.initializing) persist(); return true; },
      deleteProperty: (target, key) => { delete target[key]; persist(); return true; },
    });
    proxies.set(obj, proxy);
    return proxy;
  };
  return wrap(record.value);
}

// Los valores de presentación no convierten una pantalla recién abierta en un borrador.
export function initializeDraftDefaults(key, apply) {
  const record = drafts.get(storageKey(key));
  if (!record) return apply();
  const clean = encode(record.value) === record.base;
  record.initializing = true;
  try { apply(); } finally { record.initializing = false; if (clean) record.base = encode(record.value); window.dispatchEvent(new Event('draftchange')); }
}

export function draftVersion(key) { return drafts.has(storageKey(key)) ? encode(drafts.get(storageKey(key)).value) : null; }
// Para formularios que permanecen abiertos tras verificar: conservar el proxy y los cambios posteriores.
export function markDraftSaved(key, expected, serverValue) {
  const id = storageKey(key); const record = drafts.get(id);
  if (!record || expected === null) return;
  record.base = expected;
  record.serverBase = serverValue === undefined ? expected : encode(serverValue);
  record.changedOnServer = false;
  try { if (record.persistent && encode(record.value) !== record.base) localStorage.setItem(id, encode(record)); else localStorage.removeItem(id); } catch { /* sin almacenamiento */ }
  window.dispatchEvent(new Event('draftchange'));
}

export function discardDraft(key, expected) {
  const id = storageKey(key);
  if (expected !== undefined && draftVersion(key) !== expected) return;
  drafts.delete(id);
  try { localStorage.removeItem(id); } catch { /* sin almacenamiento */ }
  window.dispatchEvent(new Event('draftchange'));
}

export function draftNotice(keys, onDiscard) {
  const notice = h('div', { class: 'banner draft-notice', role: 'status', hidden: true });
  const refresh = () => {
    const records = keys.map((key) => drafts.get(storageKey(key))).filter(Boolean);
    const dirty = records.some((r) => encode(r.value) !== r.base);
    notice.hidden = !dirty;
    notice.replaceChildren(document.createTextNode(records.some((r) => r.changedOnServer)
      ? 'Tienes un borrador y también hay cambios en el servidor. Revisa antes de guardar. '
      : records.some((r) => !r.persistent) ? 'Cambios sin guardar. Se conservan al cambiar de sección; guarda antes de recargar. ' : 'Cambios sin guardar. Tu borrador se conserva al cambiar de sección. '));
    notice.append(h('button', { class: 'small', onclick: () => { keys.forEach((key) => discardDraft(key)); onDiscard(); } }, 'Descartar borrador'));
  };
  window.addEventListener('draftchange', refresh);
  state.timers.push(() => window.removeEventListener('draftchange', refresh));
  refresh();
  return notice;
}

window.addEventListener('sessionended', () => drafts.clear());
window.addEventListener('beforeunload', (event) => { if ([...drafts.values()].some((record) => !record.persistent && encode(record.value) !== record.base)) { event.preventDefault(); event.returnValue = ''; } });
