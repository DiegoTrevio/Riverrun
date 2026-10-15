import { api, check, confirmAction, field, fill, h, run, select, state, toast } from './core.js';
import { isSuper, withAcct } from './session.js';

/* ------------------------------ Facebook e Instagram con un botón ------------------------------ */

/**
 * Abre el inicio de sesión de Facebook. Al volver, el negocio elige qué páginas e Instagram conectar
 * (#/conectar-facebook/<sesión>). El agente elegido aquí queda propuesto en esa pantalla.
 */
export function metaConnectButton({ chatbotId = null, accountId = null, label = 'Conectar con Facebook', primary = true } = {}) {
  return h('button', { class: primary ? 'primary' : '', onclick: async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const account = accountId || state.accountId;
      const r = await run(() => api('POST', '/api/meta/connect', { chatbot_id: chatbotId || undefined, ...(isSuper() && account ? { account_id: account } : {}) }));
      if (r?.url) location.href = r.url;
    } finally { button.disabled = false; }
  } }, label);
}

/** Regreso de Facebook: páginas de la cuenta con su Instagram para elegir y el agente que las atenderá. */
export async function viewMetaConnect(root, sessionId, params) {
  root.append(h('h1', {}, 'Conectar Facebook e Instagram'));
  const error = params.get('error');
  if (!sessionId || error) {
    return root.append(h('div', { class: 'card' },
      h('p', { class: 'banner danger', role: 'alert' }, error || 'No se completó la conexión con Facebook.'),
      h('p', { class: 'muted' }, 'Vuelve a intentarlo: inicia sesión con la cuenta que administra la página y acepta todos los permisos.'),
      metaConnectButton({ label: 'Intentar de nuevo' })));
  }
  // El superadministrador vuelve de Facebook a la cuenta que estaba conectando.
  if (isSuper() && params.get('account_id')) state.accountId = params.get('account_id');
  const [session, bots] = await Promise.all([api('GET', withAcct(`/api/meta/sessions/${encodeURIComponent(sessionId)}`)), api('GET', '/api/chatbots')]);
  const accountBots = isSuper() && state.accountId ? bots.filter((b) => b.account_id === state.accountId) : bots;
  const choice = { chatbot_id: session.chatbot_id || accountBots[0]?.id || '' };
  if (!session.pages.length) {
    return root.append(h('div', { class: 'card' },
      h('p', {}, 'Facebook no devolvió ninguna página. Necesitas ser administrador de una página de Facebook; para Instagram, la cuenta debe ser profesional (empresa o creador) y estar vinculada a esa página.'),
      metaConnectButton({ label: 'Intentar con otra cuenta' })));
  }
  // Por omisión se proponen las que todavía no están conectadas.
  const picks = session.pages.map((p) => ({ page_id: p.id, messenger: !p.messenger_connected, instagram: !!p.instagram && !p.instagram.connected }));
  const result = h('div');
  root.append(
    h('p', { class: 'muted' }, 'Elige qué conectar. Los mensajes de Messenger e Instagram Direct llegarán a tus conversaciones y el agente los contestará.'),
    h('div', { class: 'card' },
      session.pages.map((p, i) => h('div', { class: 'list-item' },
        h('div', { class: 'row' },
          p.picture ? h('img', { src: p.picture, alt: '', width: 40, height: 40, style: 'border-radius:50%' }) : null,
          h('h2', { style: 'margin:0;font-size:1.05rem' }, p.name)),
        check(picks[i], 'messenger', `💬 Messenger de la página${p.messenger_connected ? ' (ya conectado: se renueva)' : ''}`),
        p.instagram
          ? check(picks[i], 'instagram', `📸 Instagram @${p.instagram.username || p.instagram.id}${p.instagram.connected ? ' (ya conectado: se renueva)' : ''}`)
          : h('p', { class: 'help' }, 'Esta página no tiene una cuenta profesional de Instagram vinculada.'))),
      accountBots.length
        ? field('Agente que responderá', select(choice, 'chatbot_id', accountBots.map((b) => [b.id, b.name])))
        : h('p', { class: 'help' }, 'Todavía no tienes agentes: las conversaciones se guardan hasta que asignes uno.'),
      h('button', { class: 'primary', onclick: async (event) => {
        const chosen = picks.filter((p) => p.messenger || p.instagram);
        if (!chosen.length) return toast('Elige al menos Messenger o Instagram de una página.', true);
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const r = await run(() => api('POST', withAcct(`/api/meta/sessions/${encodeURIComponent(sessionId)}/apply`), { chatbot_id: choice.chatbot_id || null, pages: chosen }), 'Conectado');
          if (!r) return;
          fill(result, h('div', { class: 'banner', role: 'status' },
            h('p', {}, `Listo: ${r.channels.length} ${r.channels.length === 1 ? 'conexión' : 'conexiones'} en línea.`),
            h('ul', {}, r.channels.map((c) => h('li', {}, c.type === 'instagram' ? '📸 ' : '💬 ', c.name)))),
            h('a', { class: 'btn primary', href: choice.chatbot_id ? `#/bot/${choice.chatbot_id}/conexiones` : '#/agentes?connections=1' }, 'Ver mis conexiones'));
          button.remove();
        } finally { button.disabled = false; }
      } }, 'Conectar lo elegido'),
      result),
  );
}

/** Ficha de una conexión hecha con el botón: sin tokens que copiar, solo reconectar o desconectar. */
export function metaChannelPanel(ch, { onChange }) {
  const down = ch.connection_state === 'close';
  const reason = ch.disconnect_reason === 'token_revoked'
    ? 'Facebook retiró el permiso (se cambió la contraseña, se quitó el acceso a la página o se revocó la app). Vuelve a conectar para reanudar.'
    : 'Vuelve a conectar con Facebook para reanudar.';
  return h('div', {},
    h('p', { class: 'row' },
      ch.config.picture ? h('img', { src: ch.config.picture, alt: '', width: 40, height: 40, style: 'border-radius:50%' }) : null,
      h('span', {},
        h('strong', {}, ch.config.page_name || ch.name),
        ch.type === 'instagram' && ch.config.username ? ` · @${ch.config.username}` : '',
        ' ', h('span', { class: `badge ${down ? 'red' : 'green'}` }, down ? 'Desconectado' : '✓ Conectado'))),
    down ? h('p', { class: 'banner warn', role: 'status' }, reason) : null,
    h('div', { class: 'row' },
      metaConnectButton({ chatbotId: ch.chatbot_id, accountId: ch.account_id, label: down ? 'Volver a conectar con Facebook' : 'Volver a conectar / agregar páginas', primary: down }),
      down ? null : h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmAction('¿Desconectar? El asistente dejará de recibir estos mensajes. Las conversaciones se conservan.'))) return;
        if (await run(() => api('POST', `/api/channels/${ch.id}/meta/disconnect`), 'Desconectado')) onChange();
      } }, 'Desconectar')));
}
