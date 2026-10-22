import { stepsBar } from './agentwizard.js';
import { api, confirmAction, fill, fmtPhone, h, poll, run, state } from './core.js';
import { render } from './main.js';
import { tabPlayground } from './playground.js';
import { acct, isSuper } from './session.js';
import { whatsappConnector } from './whatsapp.js';

/* ------------------------------ Crear un agente: 3. Pruébalo y conéctalo ------------------------------ */

const isLive = (bot, channels) => bot.active && channels.some((c) => c.chatbot_id === bot.id && c.connection_state === 'open');

/** «Empezar»: lleva a lo que falta (crear el primer agente, o probar y conectar el más reciente que aún no responde). */
export async function goStart(root) {
  const bots = await api('GET', `/api/chatbots${acct()}`);
  if (!root.isConnected) return;
  if (!bots.length) { location.replace('#/agentes/nuevo'); return; }
  const channels = await api('GET', `/api/channels${acct()}`);
  if (!root.isConnected) return;
  const pending = [...bots].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).find((b) => !isLive(b, channels));
  location.replace(pending ? `#/bot/${pending.id}/empezar` : '#/agentes');
}

export async function viewAgentStart(root, id) {
  const bot = await api('GET', `/api/chatbots/${id}`);
  if (!root.isConnected) return;
  const all = await api('GET', `/api/channels${isSuper() ? `?account_id=${bot.account_id}` : ''}`);
  if (!root.isConnected) return;
  const phones = all.filter((c) => c.account_id === bot.account_id && c.type === 'whatsapp');
  const mine = phones.filter((c) => c.chatbot_id === bot.id);
  const connected = mine.find((c) => c.connection_state === 'open');
  const live = bot.active && !!connected;
  const connectCard = h('section', { class: 'card', id: 'conectar-whatsapp', tabindex: '-1' });

  root.append(
    h('a', { href: '#/agentes', class: 'breadcrumb' }, '← Agentes'),
    h('h1', {}, live ? '¡Listo! Tu agente ya responde en tu WhatsApp' : 'Prueba tu agente y conéctalo'),
    stepsBar(live ? 3 : 2),
    statusLine(bot, connected, live, connectCard),
  );
  const simulator = h('div');
  // Ya conectado: lo primero es saber que está atendiendo y qué sigue; el simulador queda abajo.
  if (connected) root.append(connectCard);
  root.append(
    h('section', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Pruébalo como si fueras tu cliente'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Pregúntale precios, horarios o algo que no le enseñaste: debe decir que lo confirma con tu equipo en lugar de inventar. Si algo no te gusta, ', h('a', { href: `#/bot/${bot.id}/conocimiento` }, 'enséñale más'), ' o ', h('a', { href: `#/bot/${bot.id}/instrucciones` }, 'ajusta cómo atiende'), '.')),
    simulator,
    connected ? null : connectCard,
  );
  drawConnect(connectCard, bot, { phones, mine, connected, live });
  await tabPlayground(simulator, bot);
}

/** Qué pasa ahora con el agente, en una línea. */
function statusLine(bot, connected, live, connectCard) {
  const goConnect = h('button', { class: 'small', onclick: () => { connectCard.scrollIntoView({ block: 'start', behavior: 'smooth' }); connectCard.focus({ preventScroll: true }); } }, 'Conectar mi WhatsApp ↓');
  const turnOn = h('button', { class: 'small primary', onclick: async () => { if (await run(() => api('PUT', `/api/chatbots/${bot.id}`, { active: true }), 'Agente encendido')) render(); } }, 'Encender agente');
  if (live) return null;
  if (!bot.active && bot.start_on_connect) {
    return h('p', { class: 'banner', role: 'status' },
      'Todavía no contesta a tus clientes: ', h('strong', {}, 'se encenderá solo en cuanto conectes tu WhatsApp'), '. ', connected ? null : goConnect, ' ',
      h('button', { class: 'small', onclick: async () => {
        // Apagarlo a mano quita el encendido automático: queda en sus manos.
        if (await run(() => api('PUT', `/api/chatbots/${bot.id}`, { active: false }), 'Listo: lo enciendes tú cuando quieras')) render();
      } }, 'Prefiero encenderlo yo después'));
  }
  if (!bot.active) return h('p', { class: 'banner warn', role: 'status' }, 'Está apagado: no contesta a tus clientes. ', turnOn);
  return h('p', { class: 'banner', role: 'status' }, 'Está encendido: contestará en cuanto conectes tu WhatsApp. ', goConnect);
}

function drawConnect(card, bot, { phones, mine, connected, live }) {
  const title = h('h2', { style: 'margin-top:0' }, 'Conecta tu WhatsApp');
  const intro = h('p', { class: 'muted' }, 'Puede ser WhatsApp normal o WhatsApp Business. Sigues usando WhatsApp en tu teléfono como siempre; si tú contestas una conversación, tu agente se pausa en ella.');
  if (connected) return fill(card, h('h2', { style: 'margin-top:0' }, live ? 'Tu agente ya está atendiendo' : 'Tu WhatsApp está conectado'), doneBody(bot, connected, live));

  const verifyNeeded = !isSuper() && state.meta.require_email && !state.me.user.email_verified_at;
  if (verifyNeeded) {
    fill(card, title, intro, h('div', { class: 'banner warn' },
      h('strong', {}, 'Confirma tu correo para conectar WhatsApp. '), `Te enviamos un enlace a ${state.me.user.email}; ábrelo y regresa aquí.`,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'small', onclick: () => run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace') }, 'Reenviar correo'),
        h('button', { class: 'small', onclick: () => { state.me = null; render(); } }, 'Ya lo confirmé'))));
    // Al confirmarlo en otra pestaña, esta se actualiza sola.
    poll(async () => { const me = await api('GET', '/api/me'); if (me.user.email_verified_at) { state.me = null; render(); } }, 8000, card);
    return;
  }

  const area = h('div');
  const others = phones.filter((c) => c.chatbot_id !== bot.id);
  const start = h('button', { class: 'primary', onclick: async () => {
    start.disabled = true;
    try {
      const ch = await api('POST', `/api/chatbots/${bot.id}/whatsapp`);
      const nav = state.navigation;
      fill(area, whatsappConnector(ch.id, { onConnected: () => { state.me = null; setTimeout(() => { if (nav === state.navigation) render(); }, 2500); } }));
      start.hidden = true;
    } catch (e) {
      start.disabled = false;
      fill(area, h('div', { class: 'banner danger', role: 'alert' }, e.message, ' ',
        e.status === 409 ? h('a', { href: `#/bot/${bot.id}/conexiones` }, 'Ver mis conexiones') : e.status === 403 && /plan/i.test(e.message) ? h('a', { href: '#/plan' }, 'Ver planes') : null));
    }
  } }, mine.length ? 'Mostrar mi código QR' : 'Conectar mi WhatsApp');

  fill(card, title, intro, start, area,
    others.length ? h('details', { style: 'margin-top:12px' },
      h('summary', {}, '¿Ya conectaste un WhatsApp en otro agente? Úsalo aquí'),
      h('p', { class: 'small muted' }, 'El número deja de atenderlo el otro agente y pasa a este. Sus conversaciones se conservan.'),
      others.map((c) => h('div', { class: 'row', style: 'margin:6px 0' },
        h('span', {}, `${c.name}${c.config?.number ? ` · ${fmtPhone(c.config.number)}` : ''}`),
        h('button', { class: 'small', onclick: async () => {
          if (!(await confirmAction(`¿Usar «${c.name}» con este agente? El otro agente deja de atender ese número.`))) return;
          if (await run(() => api('PUT', `/api/channels/${c.id}`, { chatbot_id: bot.id }), 'Listo: ese WhatsApp ahora lo atiende este agente')) render();
        } }, 'Usar con este agente')))) : null);
}

/** Ya conectado: qué sigue. */
function doneBody(bot, ch, live) {
  const number = ch.config?.number ? ` (${fmtPhone(ch.config.number)})` : '';
  const books = bot.rules?.booking_enabled;
  return [
    live
      ? h('p', {}, h('strong', {}, `Tu agente ya responde en tu WhatsApp${number}.`), ' Haz la prueba: escríbele desde otro teléfono.')
      : h('p', {}, `Tu WhatsApp${number} quedó conectado, pero tu agente está apagado y no contesta. `,
        h('button', { class: 'small primary', onclick: async () => { if (await run(() => api('PUT', `/api/chatbots/${bot.id}`, { active: true }), 'Agente encendido')) render(); } }, 'Encender agente')),
    h('h3', {}, 'Lo que puedes hacer ahora'),
    h('ul', {},
      h('li', {}, h('a', { href: `#/conversations?chatbot_id=${bot.id}` }, 'Ver las conversaciones'), ' y tomar el control cuando quieras.'),
      h('li', {}, h('a', { href: `#/bot/${bot.id}/conocimiento` }, 'Enseñarle más'), ' (precios, promociones, preguntas frecuentes).'),
      h('li', {}, h('a', { href: `#/bot/${bot.id}/instrucciones` }, 'Ajustar cómo atiende'), ' o pausarlo.'),
      books ? h('li', {}, h('a', { href: '#/automation/settings' }, 'Revisar tu horario'), ' para que ofrezca las citas correctas.') : null,
      h('li', {}, h('a', { href: `#/bot/${bot.id}/conexiones` }, 'Conectar Facebook, Instagram u otro teléfono'), '.'),
      h('li', {}, h('a', { href: '#/users' }, 'Invitar a tu equipo'), '.')),
  ];
}
