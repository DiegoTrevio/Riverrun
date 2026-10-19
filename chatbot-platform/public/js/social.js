import { channelIcon, networkLabel } from './channels.js';
import { api, confirmAction, field, fill, h, run, state, text, toast } from './core.js';
import { render } from './main.js';

/**
 * Conexión de una red social (Zernio) desde el panel, como el QR de WhatsApp: el negocio elige la red, la autoriza y ve
 * aquí la cuenta conectada, su estado y las opciones para reconectar o desconectar. Nunca ve llaves ni identificadores.
 */
export function socialConnector(ch, { persist, setup, cfg }) {
  const root = h('div', { class: 'social-connect' });
  const network = () => (state.meta.social_networks || []).find((n) => n.id === cfg.platform);
  let busy = false;
  let poller = null;
  const stop = () => { clearInterval(poller); poller = null; };

  /** Guarda la red elegida y pide a Zernio la forma de conectarla. */
  const start = async (body = {}) => {
    if (busy) return; busy = true;
    try {
      const snapshot = JSON.stringify(cfg);
      if (!(await persist())) return;
      if (JSON.stringify(cfg) !== snapshot) return toast('Cambiaste los datos. Vuelve a pulsar conectar.', true);
      const r = await run(() => api('POST', `/api/channels/${ch.id}/zernio/connect`, body));
      if (!r) return;
      if (r.kind === 'oauth') { location.href = r.authUrl; return; }
      if (r.kind === 'code') return drawCode(r);
      if (r.kind === 'connected') { toast(`${networkLabel(cfg.platform)} conectado`); render(); }
    } finally { busy = false; }
  };

  function drawCode(r) {
    const status = h('p', { role: 'status', class: 'muted' }, 'Esperando el código en tu bot…');
    fill(root,
      h('div', { class: 'card', style: 'background:var(--bg)' },
        h('p', {}, 'Envía este código a ', r.botUsername ? h('strong', {}, `@${r.botUsername.replace(/^@/, '')}`) : 'el bot de conexión', ':'),
        h('p', { style: 'font-size:28px;font-weight:700;letter-spacing:2px;margin:8px 0' }, r.code,
          ' ', h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(r.code); toast('Copiado'); } catch { toast('Cópialo a mano', true); } } }, 'Copiar')),
        r.instructions?.length ? h('ol', { class: 'small' }, r.instructions.map((i) => h('li', {}, i))) : null,
        status,
        h('button', { onclick: () => { stop(); draw(); } }, 'Cancelar')));
    stop();
    let inflight = false;
    poller = setInterval(async () => {
      if (!root.isConnected) return stop();
      if (document.hidden || inflight) return;
      inflight = true;
      try {
        const s = await api('POST', `/api/channels/${ch.id}/zernio/telegram-check`);
        if (s.status === 'connected') { stop(); toast('Telegram conectado'); render(); }
        else if (s.status === 'expired') { stop(); fill(status, 'El código venció. ', h('button', { class: 'small', onclick: () => start() }, 'Pedir otro código')); }
      } catch (e) { status.textContent = e.message; }
      finally { inflight = false; }
    }, 3000);
    state.timers.push(poller);
  }

  function connectedView() {
    const c = ch.config;
    const down = ch.connection_state === 'close';
    const avatar = /^https:\/\//.test(c.picture || '')
      ? h('img', { src: c.picture, alt: '', width: 48, height: 48, style: 'border-radius:50%;object-fit:cover', referrerpolicy: 'no-referrer' })
      : h('span', { style: 'font-size:32px' }, channelIcon('zernio', c.platform));
    return [
      h('div', { class: 'row', style: 'gap:12px;align-items:center' }, avatar,
        h('div', {},
          h('strong', {}, c.display_name || c.username || networkLabel(c.platform)),
          h('div', { class: 'small muted' }, networkLabel(c.platform), c.username ? ` · @${c.username}` : ''),
          h('span', { class: `badge ${down ? 'red' : 'green'}` }, down ? 'Desconectado: vuelve a conectar' : '✓ Conectado'))),
      h('p', { class: 'small muted' }, 'Los mensajes directos que reciba esta cuenta llegan a Conversaciones y el agente los contesta.'),
      h('div', { class: 'row' },
        h('button', { class: down ? 'primary' : '', onclick: () => draw(true) }, 'Reconectar'),
        h('button', { onclick: setup }, 'Revisar conexión'),
        h('button', { class: 'danger', onclick: async () => {
          if (!(await confirmAction(`¿Desconectar ${networkLabel(c.platform)}? El agente dejará de responder por aquí.`))) return;
          if (await run(() => api('POST', `/api/channels/${ch.id}/zernio/disconnect`), 'Desconectado')) render();
        } }, 'Desconectar')),
    ];
  }

  function connectView() {
    const n = network();
    if (!n) return [h('p', { class: 'muted' }, 'Elige la red en Configuración y guarda.')];
    if (n.flow === 'code') {
      return [
        h('p', {}, 'Conecta tu bot o canal de Telegram con un código: te damos el código, lo envías al bot y en segundos queda conectado.'),
        h('button', { class: 'primary', onclick: () => start() }, 'Obtener código de Telegram'),
      ];
    }
    if (n.flow === 'credentials') {
      const creds = { identifier: '', app_password: '' };
      return [
        h('p', {}, 'Bluesky se conecta con tu usuario y una ', h('strong', {}, 'contraseña de aplicación'), ' (no la de tu cuenta). Créala en Bluesky → Ajustes → Privacidad y seguridad → Contraseñas de aplicación, y marca que pueda leer mensajes directos.'),
        h('div', { class: 'grid' },
          field('Usuario', text(creds, 'identifier', { placeholder: 'tunegocio.bsky.social', autocomplete: 'username' })),
          field('Contraseña de aplicación', text(creds, 'app_password', { type: 'password', placeholder: 'xxxx-xxxx-xxxx-xxxx', autocomplete: 'off' }))),
        h('button', { class: 'primary', onclick: () => start(creds) }, 'Conectar Bluesky'),
      ];
    }
    return [
      h('p', {}, `Pulsa el botón, inicia sesión en ${n.label} y autoriza el acceso a tus mensajes. Al terminar regresas aquí con la cuenta conectada.`),
      n.id === 'whatsapp' ? h('p', { class: 'small muted' }, 'Esto conecta la API oficial de WhatsApp Business (Meta): elige tu número durante la autorización. Fuera de la ventana de 24 horas, Meta solo permite plantillas aprobadas. Para vincular un WhatsApp normal con QR, crea una conexión de WhatsApp.') : null,
      n.id === 'instagram' ? h('p', { class: 'small muted' }, 'Tu cuenta de Instagram debe ser profesional (de empresa o creador).') : null,
      n.id === 'facebook' ? h('p', { class: 'small muted' }, 'Elige la página de Facebook cuyos mensajes de Messenger quieres atender.') : null,
      h('button', { class: 'primary', onclick: () => start() }, `Conectar con ${n.label}`),
    ];
  }

  function draw(reconnect = false) {
    stop();
    if (!state.meta.zernio_enabled && !ch.config.api_key) {
      return fill(root, h('p', { class: 'banner warn' }, 'Las redes sociales no están activadas en esta instalación. Pide al administrador que configure Zernio.'));
    }
    fill(root, returnNotice(), ch.config.connected && !reconnect ? connectedView() : connectView());
  }

  /** Al volver de Zernio sin conectar: por qué (con textos fijos; el código viene en la dirección). */
  function returnNotice() {
    const code = new URLSearchParams(location.hash.split('?')[1] || '').get('zernio');
    const why = {
      not_yours: 'Esa cuenta no pertenece a este negocio. Vuelve a pulsar "Conectar" e inicia sesión con la cuenta correcta.',
      in_use: 'Esa cuenta ya está conectada en otra conexión. Desconéctala ahí primero.',
      cancelled: 'No se terminó la autorización. Puedes intentarlo de nuevo cuando quieras.',
      error: 'No se pudo completar la conexión. Inténtalo de nuevo; si sigue fallando, avísanos.',
    }[code];
    return why ? h('p', { class: 'banner warn', role: 'alert' }, why) : null;
  }

  // Si cambia la red elegida en Configuración, se redibuja la forma de conectarla.
  const onPlatform = () => { if (!root.isConnected) return document.removeEventListener('cp-social-platform', onPlatform); if (!ch.config.connected) draw(); };
  document.addEventListener('cp-social-platform', onPlatform);
  draw();
  return root;
}
