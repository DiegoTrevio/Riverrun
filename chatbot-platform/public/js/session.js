import { api, state } from './core.js';

export function clearTimers() {
  state.timers.forEach((t) => typeof t === 'function' ? t() : clearInterval(t));
  state.timers = [];
}

export const ROLE_LABEL = { superadmin: 'Maestro · todos los perfiles', admin: 'Administrador del perfil', agent: 'Operador del perfil' };

export const isAdmin = () => state.me && state.me.user.role !== 'agent';

export const isSuper = () => state.me && state.me.user.role === 'superadmin';

/** El dueño de la cuenta (o el superadmin): el único que maneja el dinero, la cuenta y a los administradores. */
export const isOwner = () => !!(isSuper() || (state.me?.owner && state.me.owner.id === state.me.user.id));
export const ownerOnlyText = () => `Solo el dueño de la cuenta (${state.me?.owner?.name || 'sin dueño'}) puede hacer esto`;

/** Filtro de cuenta para listados (el superadmin puede elegir una o ver todas). */
export const acct = (prefix = '?') => (isSuper() && state.accountId ? `${prefix}account_id=${state.accountId}` : '');

export const accountName = (id) => state.accounts.find((a) => a.id === id)?.name || '';

export async function loadSession() {
  const nav = state.navigation;
  const [meta, me, accounts] = await Promise.all([api('GET', '/api/meta'), api('GET', '/api/me'), api('GET', '/api/accounts?view=selector')]);
  if (nav !== state.navigation) return;
  state.meta = meta;
  state.me = me;
  state.accounts = accounts;
  if (me.account) state.accountId = me.account.id;
  state.timeZone = '';
  if (state.accountId && !accounts.some((a) => a.id === state.accountId)) state.accountId = '';
}

/** El Copiloto está disponible: encendido para la cuenta (el superadmin, en la cuenta que tenga elegida). */
export const copilotAvailable = () => !!state.me?.copilot?.enabled && (!isSuper() || !!state.accounts.find((a) => a.id === state.accountId)?.copilot_enabled);

export const withAcct = (url) => url + (isSuper() && state.accountId ? `${url.includes('?') ? '&' : '?'}account_id=${state.accountId}` : '');
