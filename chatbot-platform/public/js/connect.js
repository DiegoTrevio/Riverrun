import { api, state } from './core.js';
import { isSuper, withAcct } from './session.js';

/* ------------------------------ ¿Está conectado el WhatsApp? (aviso arriba del panel) ------------------------------ */
// La conexión con QR o por número vive en whatsapp.js y se muestra en la conexión de cada agente (#/channel/:id).

/** ¿Hay un WhatsApp conectado? Se consulta en cada navegación para avisar arriba cuando no lo está. */
export async function loadWhatsappStatus() {
  const nav = state.navigation;
  state.wa = null;
  const { user } = state.me;
  if (!['admin', 'superadmin'].includes(user.role) || (isSuper() && !state.accountId)) return;
  try {
    const list = (await api('GET', withAcct('/api/channels'))).filter((c) => c.type === 'whatsapp');
    if (nav !== state.navigation) return;
    // id: el que hay que reconectar (el primero sin conexión).
    state.wa = { has: list.length > 0, connected: list.some((c) => c.connection_state === 'open'), id: (list.find((c) => c.connection_state !== 'open') || list[0])?.id };
  } catch { /* sin aviso */ }
}
