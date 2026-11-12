import { api, h, invalidateReads, state, toast } from './core.js';
import { icon } from './icons.js';
import { render } from './main.js';
import { isSuper } from './session.js';

/*
 * Cambiar de perfil de negocio (solo la cuenta maestra): el selector con búsqueda del menú lateral, el aviso de en qué
 * perfil estás y un solo lugar para entrar a un perfil (cada entrada queda en la bitácora de seguridad del negocio).
 */

const STORED = 'cp-account';
const RECENT = 'cp-recent-accounts';
const MAX_RECENT = 5;

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* sin almacenamiento: el cambio vale solo en esta pestaña */ }
}

/** Perfiles abiertos hace poco (los más nuevos primero), solo los que todavía existen. */
export function recentAccounts() {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { /* lista dañada o sin almacenamiento: sin recientes */ }
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => state.accounts.find((a) => a.id === id)).filter(Boolean);
}

function pushRecent(id) {
  remember(RECENT, JSON.stringify([id, ...recentAccounts().map((a) => a.id).filter((x) => x !== id)].slice(0, MAX_RECENT)));
}

/** Cada cambio pedido lleva su número: si se eligen dos perfiles seguidos, gana el último elegido, no el que responda al final. */
let latest = 0;

/** Un enlace que abrió otro perfil (?account_id=, p. ej. desde un aviso de Consumo o Registros) no debe dejarlo fijo. */
function dropAccountFromHash() {
  if (!location.hash.includes('?')) return;
  const [route, query] = location.hash.split('?');
  const filters = new URLSearchParams(query);
  if (!filters.has('account_id')) return;
  filters.delete('account_id');
  history.replaceState(null, '', route + (filters.size ? '?' + filters : ''));
}

/**
 * Elige el perfil con el que trabaja la cuenta maestra ('' = todos). Al entrar a un negocio primero se anota en su
 * bitácora (el servidor también anota cualquier petición con account_id); si no lo acepta (el perfil ya no existe, la
 * sesión venció) no se cambia. Devuelve si cambió.
 * `redraw: false` cuando quien llama navega o dibuja por su cuenta.
 */
export async function enterAccount(id, { redraw = true } = {}) {
  if (!isSuper()) return false;
  if (id === state.accountId) return true;
  const mine = ++latest;
  if (id) {
    try {
      await api('POST', `/api/accounts/${encodeURIComponent(id)}/switch`);
    } catch (e) {
      if (mine === latest) toast(e.message || 'No se pudo abrir el perfil', true);
      return false;
    }
    if (mine !== latest) return false;
    pushRecent(id);
  }
  state.accountId = id;
  remember(STORED, id);
  invalidateReads();
  if (!redraw) return true;
  dropAccountFromHash();
  // Las pantallas de un asistente o un canal son de un perfil: al cambiar se vuelve a la lista de agentes.
  if (/^#\/(bot|channel|agentes\/conexion)\//.test(location.hash)) location.hash = '#/agentes';
  else render();
  return true;
}

/** Un clic normal (no Ctrl/Cmd/Mayús para abrir otra pestaña): solo ese entra al perfil antes de seguir el enlace. */
export const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const currentName = () => state.accounts.find((a) => a.id === state.accountId)?.name || '';

let pickers = 0;
/**
 * El selector del menú lateral: un botón con el perfil actual que abre una búsqueda (patrón combobox con lista).
 * Flechas para moverse, Intro para entrar, Escape para cerrar. Sin texto muestra primero los recientes.
 * Devuelve el elemento con `openPicker()` para abrirlo desde el aviso de arriba.
 */
export function accountPicker() {
  const n = ++pickers;
  const listId = `profile-list-${n}`;
  let options = [];
  let active = 0;

  const name = currentName();
  const button = h('button', { type: 'button', id: 'profile-switch', class: 'account-switch-button', 'aria-expanded': 'false', 'aria-controls': `profile-panel-${n}`,
    onclick: () => (panel.hidden ? open() : close(true)) },
  h('span', { class: 'account-switch-text' }, h('span', {}, name ? 'Estás dentro de' : 'Cuenta maestra'), h('strong', {}, name || 'Todos los perfiles'), h('span', { class: 'sr-only' }, '. Cambiar de perfil')),
  icon('chevron', 16));

  const input = h('input', { type: 'search', role: 'combobox', 'aria-label': 'Buscar perfil de negocio', 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': listId,
    placeholder: `Buscar entre ${state.accounts.length} perfiles`, autocomplete: 'off', oninput: () => { active = 0; draw(); },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) choose(options[active].id); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    } });
  const list = h('ul', { id: listId, role: 'listbox', class: 'account-switch-list', 'aria-label': 'Perfiles de negocio' });
  // Cuántos perfiles coinciden, para el lector de pantalla; sin coincidencias, también a la vista.
  const status = h('p', { class: 'small muted account-switch-empty', role: 'status' });
  const panel = h('div', { id: `profile-panel-${n}`, class: 'account-switch-panel', hidden: true,
    // Con Tab fuera del selector, se cierra (sin robar el foco a donde fue).
    onfocusout: (e) => { if (!panel.hidden && e.relatedTarget && !wrap.contains(e.relatedTarget)) close(); } }, input, list, status);

  function entries() {
    const q = fold(input.value.trim());
    if (q) return state.accounts.filter((a) => fold(a.name).includes(q));
    const recent = recentAccounts();
    const rest = state.accounts.filter((a) => !recent.includes(a));
    return [{ id: '', name: 'Todos los perfiles' }, ...recent.map((a) => ({ ...a, recent: true })), ...rest];
  }
  function draw() {
    options = entries();
    if (active >= options.length) active = Math.max(0, options.length - 1);
    list.replaceChildren(...options.map((a, i) => h('li', { id: `${listId}-${i}`, role: 'option', 'data-account': a.id, class: i === active ? 'active' : '', 'aria-selected': String(a.id === state.accountId),
      onmousedown: (e) => e.preventDefault(), onclick: () => choose(a.id) },
    h('span', { class: 'name' }, a.name),
    a.recent ? h('span', { class: 'small muted' }, 'reciente') : null,
    a.active === false ? h('span', { class: 'badge orange' }, 'inactiva') : null,
    a.id === state.accountId ? icon('check', 14) : null)));
    if (options.length) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
    const found = input.value.trim() ? options.length : null;
    status.textContent = found === 0 ? 'Ningún perfil se llama así' : found === null ? '' : `${found} ${found === 1 ? 'perfil' : 'perfiles'}`;
    status.classList.toggle('sr-only', !!found);
  }
  function move(step) {
    if (!options.length) return;
    active = (active + step + options.length) % options.length;
    draw();
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  function open() {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    input.value = '';
    active = 0;
    draw();
    input.focus();
    // Después de este clic: si se abrió desde el aviso de arriba, ese mismo clic no debe cerrarlo.
    setTimeout(() => { if (!panel.hidden) document.addEventListener('click', outside); });
  }
  function close(focusButton = false) {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside);
    if (focusButton) button.focus();
  }
  function outside(e) {
    if (!wrap.isConnected) return document.removeEventListener('click', outside);
    if (!wrap.contains(e.target)) close();
  }
  async function choose(id) {
    close(true);
    if (id !== state.accountId) await enterAccount(id);
  }

  const wrap = h('div', { class: `account-switch picker${name ? ' inside' : ''}` }, button, panel);
  wrap.openPicker = open;
  return wrap;
}

/** Aviso fijo arriba de cada pantalla mientras la cuenta maestra está dentro de un negocio. */
export function masterBanner(onChange) {
  if (!isSuper() || !state.accountId) return null;
  const acc = state.accounts.find((a) => a.id === state.accountId);
  if (!acc) return null;
  return h('div', { class: 'banner master', role: 'status' },
    icon('key', 16),
    h('span', { class: 'text' }, 'Estás dentro de ', h('strong', {}, acc.name), ' con la cuenta maestra. Lo que cambies aquí afecta a este negocio.',
      acc.active === false ? ' Este perfil está inactivo.' : ''),
    h('button', { type: 'button', class: 'btn', onclick: onChange }, 'Cambiar de perfil'),
    h('button', { type: 'button', class: 'btn', onclick: () => enterAccount('') }, 'Ver todos los perfiles'));
}
