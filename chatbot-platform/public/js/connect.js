import { api, field, fill, h, run, state, text, confirmAction } from './core.js';
import { whatsappConnector } from './whatsapp.js';
import { render } from './main.js';
import { isSuper, withAcct } from './session.js';

/* ------------------------------ Conectar WhatsApp (página propia, fácil de encontrar) ------------------------------ */

/** ¿Hay un WhatsApp conectado? Se consulta en cada navegación para avisar arriba cuando no lo está. */
export async function loadWhatsappStatus() {
  const nav = state.navigation;
  state.wa = null;
  const { user } = state.me;
  if (!['admin', 'superadmin'].includes(user.role) || (isSuper() && !state.accountId)) return;
  try {
    const list = (await api('GET', withAcct('/api/channels'))).filter((c) => c.type === 'whatsapp');
    if (nav !== state.navigation) return;
    state.wa = { has: list.length > 0, connected: list.some((c) => c.connection_state === 'open'), id: list[0]?.id };
  } catch { /* sin aviso */ }
}

const pretty = (n) => (n ? `+${String(n).replace(/\D/g, '')}` : '');

/** Tarjeta de un número ya conectado: estado, prueba de envío y cambio de número. */
function connectedCard(ch, onChange) {
  const t = { number: '', text: 'Mensaje de prueba ✅' };
  const box = h('div');
  return h('div', { class: 'card' },
    h('div', { class: 'wa-done' }, h('div', { class: 'wa-check' }, '✓'),
      h('h2', {}, '¡WhatsApp conectado!'),
      h('p', {}, ch.config.profile_name ? [h('strong', {}, ch.config.profile_name), ' · '] : null, ch.config.number ? pretty(ch.config.number) : ch.name),
      h('p', { class: 'small muted' }, 'Teléfono conectado. La atención depende de que el agente esté encendido y de sus reglas de activación.')),
    h('details', {}, h('summary', {}, 'Enviarme un mensaje de prueba'),
      h('div', { class: 'grid', style: 'margin-top:10px' }, field('Número (con lada)', text(t, 'number', { placeholder: '5215512345678' })), field('Texto', text(t, 'text'))),
      h('button', { onclick: () => run(() => api('POST', `/api/channels/${ch.id}/whatsapp/test`, { number: t.number, text: t.text }), 'Enviado ✅') }, 'Enviar')),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'small danger', onclick: async () => {
        if (!await confirmAction('¿Desvincular este WhatsApp? Tu asistente dejará de responder hasta que vincules un número.')) return;
        if (await run(() => api('POST', `/api/channels/${ch.id}/whatsapp/logout`), 'Desvinculado')) onChange();
      } }, 'Desvincular y conectar otro número'),
      h('a', { class: 'btn small', href: `#/channel/${ch.id}` }, 'Ajustes del canal')),
    box);
}

export async function viewConnect(root, params) {
  root.append(h('h1', {}, '📱 Conectar WhatsApp'));
  if (isSuper() && !state.accountId) return root.append(h('div', { class: 'card' }, h('p', {}, 'Elige un perfil arriba (menú lateral) para conectar su WhatsApp.')));
  const holder = h('div', { class: 'stack' });
  root.append(holder);
  const all = (await api('GET', withAcct('/api/channels'))).filter((c) => c.type === 'whatsapp' && (!isSuper() || c.account_id === state.accountId));
  const only = params?.get('channel');
  const list = only ? all.filter((c) => c.id === only) : all;

  const connectBox = (ch) => {
    const box = h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, list.length > 1 ? `Conectar ${ch.name}` : 'Escanea el código con tu teléfono'),
      whatsappConnector(ch.id, { onConnected: () => { const nav = state.navigation; const timer = setTimeout(() => { if (nav === state.navigation && root.isConnected) render(); }, 2500); state.timers.push(timer); } }));
    return box;
  };

  if (!list.length) {
    const msg = h('div');
    return fill(holder,
      h('div', { class: 'card' },
        h('p', {}, 'Conecta el WhatsApp de tu negocio para que tu asistente responda a tus clientes. Te mostraremos un código QR para escanearlo desde tu teléfono; toma menos de un minuto.'),
        h('button', { class: 'primary', onclick: async () => {
          const ch = await run(() => api('POST', withAcct('/api/onboarding/whatsapp')));
          if (!ch) return fill(msg, h('p', { class: 'small' }, 'Si te pide configurar tu asistente, hazlo primero en ', h('a', { href: '#/inicio' }, 'Primeros pasos'), '.'));
          state.me = null; render();
        } }, 'Conectar mi WhatsApp'),
        msg));
  }

  for (const ch of list) {
    const slot = h('div');
    holder.append(slot);
    fill(slot, h('div', { class: 'card muted' }, 'Revisando conexión…'));
    api('GET', `/api/channels/${ch.id}/status`).catch(() => ({ state: ch.connection_state })).then((s) => {
      if (s.state === 'open') fill(slot, connectedCard(ch, () => { state.me = null; render(); }));
      else fill(slot, connectBox(ch));
    });
  }
}
