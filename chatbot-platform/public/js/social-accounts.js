import { api, confirmAction, field, fill, h, run, state, toast } from './core.js';
import { render } from './main.js';
import { isSuper, withAcct } from './session.js';

/**
 * Redes sociales del negocio (por Zernio): las cuentas conectadas, quién contesta los mensajes de cada una y el botón
 * para conectar otra red. El negocio nunca ve llaves ni identificadores de Zernio.
 */

const ICONS = { instagram: '📸', facebook: '📘', whatsapp: '🟢', telegram: '✈️', twitter: '𝕏', bluesky: '🦋', reddit: '👽', linkedin: '💼', tiktok: '🎵', youtube: '▶️', threads: '🧵', pinterest: '📌', googlebusiness: '🗺️' };
const STATUS = { active: ['green', 'Conectada'], needs_reconnect: ['red', 'Hay que reconectarla'], disconnected: ['red', 'Desconectada'], stale: ['orange', 'Hay que volver a conectarla'] };
const RETURN = {
  ok: 'Listo: la red quedó conectada.',
  not_yours: 'Esa cuenta no pertenece a este negocio. Vuelve a pulsar "Conectar" e inicia sesión con la cuenta correcta.',
  in_use: 'Esa cuenta ya está conectada en otro negocio o conexión.',
  cancelled: 'No se terminó la autorización. Puedes intentarlo de nuevo cuando quieras.',
  expired: 'El enlace para conectar venció. Vuelve a pulsar "Conectar".',
  limit: 'Tu plan no permite más redes sociales conectadas. Cámbialo en Ajustes → Mi plan y pagos.',
  error: 'No se pudo completar la conexión. Inténtalo de nuevo; si sigue fallando, avísanos.',
};

/** Lo que permite una red, en palabras simples. */
const can = (n) => [n.dm ? 'mensajes' : null, n.comments ? 'comentarios' : null, n.reviews ? 'reseñas' : null, n.posts ? 'publicaciones' : null, n.analytics ? 'estadísticas' : null].filter(Boolean).join(' · ');

export async function viewSocialAccounts(root, params = new URLSearchParams()) {
  const networks = state.meta.social_capabilities || [];
  if (!state.meta.zernio_enabled) {
    root.append(h('h1', {}, 'Redes sociales'), h('p', { class: 'banner warn' }, 'Las redes sociales no están activadas en esta instalación. Pide al administrador que configure Zernio.'));
    return;
  }
  const [data, bots] = await Promise.all([api('GET', withAcct('/api/social-accounts')), api('GET', withAcct('/api/chatbots'))]);
  if (!root.isConnected) return;
  const code = params.get('zernio');
  const notice = RETURN[code] ? h('p', { class: `banner ${code === 'ok' ? '' : 'warn'}`, role: code === 'ok' ? 'status' : 'alert' }, RETURN[code]) : null;
  const byId = Object.fromEntries(networks.map((n) => [n.id, n]));

  const connect = async (platform, chatbotId = '', reconnect = '') => {
    const r = await run(() => api('POST', withAcct('/api/social-accounts/connect'), { platform, chatbot_id: chatbotId || null, ...(reconnect ? { reconnect } : {}) }));
    if (!r) return;
    // Mensajes directos con Telegram o Bluesky: se termina en su conexión (código para el bot o contraseña de aplicación).
    if (r.kind === 'channel') { location.hash = `#/agentes/conexion/${r.channel_id}`; return; }
    if (r.authUrl) location.href = r.authUrl;
  };

  const accountCard = (a) => {
    const n = byId[a.platform] || { label: a.platform };
    const [color, label] = STATUS[a.status] || ['', a.status];
    const avatar = /^https:\/\//.test(a.picture || '')
      ? h('img', { src: a.picture, alt: '', width: 44, height: 44, style: 'border-radius:50%;object-fit:cover', referrerpolicy: 'no-referrer' })
      : h('span', { style: 'font-size:30px', 'aria-hidden': 'true' }, ICONS[a.platform] || '🔗');
    const agent = a.dm ? h('select', {
      'aria-label': `Quién contesta los mensajes de ${n.label}`,
      onchange: async (e) => { if (await run(() => api('PUT', withAcct(`/api/social-accounts/${a.id}`), { chatbot_id: e.target.value || null }), 'Guardado')) render(); },
    }, h('option', { value: '' }, 'Nadie: solo se guardan'), bots.map((b) => h('option', { value: b.id, selected: a.chatbot_id === b.id }, b.name))) : null;
    return h('div', { class: 'list-item' },
      h('div', { class: 'row', style: 'gap:12px;align-items:center' }, avatar,
        h('div', { style: 'flex:1;min-width:0' },
          h('strong', {}, a.display_name || a.username || n.label),
          h('div', { class: 'small muted' }, n.label, a.username ? ` · @${a.username}` : ''),
          h('span', { class: `badge ${color}` }, label)),
        h('div', { class: 'row' },
          a.status !== 'active' ? h('button', { class: 'small primary', onclick: () => connect(a.platform, a.chatbot_id, n.flow === 'oauth' ? a.id : '') }, 'Reconectar') : null,
          h('button', { class: 'small danger', onclick: async () => {
            if (!(await confirmAction(`¿Desconectar ${n.label}${a.username ? ` (@${a.username})` : ''}? Dejarás de recibir sus mensajes y comentarios aquí.`))) return;
            if (await run(() => api('POST', withAcct(`/api/social-accounts/${a.id}/disconnect`)), 'Desconectada')) render();
          } }, 'Desconectar'))),
      a.dm ? field('Contesta sus mensajes', agent, a.chatbot_id ? 'Tu agente responde los mensajes directos de esta cuenta.' : 'Elige un agente para que conteste los mensajes directos.') : null);
  };

  root.append(
    h('h1', {}, 'Redes sociales'),
    h('p', { class: 'muted' }, 'Conecta las redes de tu negocio. En las que tienen mensajes directos tu agente puede contestar; tú inicias sesión en cada red y autorizas el acceso.'),
    notice,
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Tus redes conectadas'),
      data.accounts.length ? data.accounts.map(accountCard) : h('p', { class: 'muted' }, 'Todavía no conectas ninguna red.'),
      data.limit?.max ? h('p', { class: 'small muted', style: 'margin-bottom:0' }, `Usas ${data.limit.used} de ${data.limit.max} redes que incluye tu plan.`) : null),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Conectar otra red'),
      data.meta_direct ? h('p', { class: 'small muted' }, 'Facebook e Instagram ya se conectan con el botón "Conectar con Facebook" en las conexiones de tu agente; aquí solo se usan para comentarios, publicaciones y estadísticas.') : null,
      h('div', { class: 'grid' }, networks.map((n) => h('button', { class: 'social-network', onclick: () => connect(n.id) },
        h('span', { style: 'font-size:24px', 'aria-hidden': 'true' }, ICONS[n.id] || '🔗'),
        h('span', {}, h('strong', {}, n.label), h('br'), h('span', { class: 'small muted' }, can(n))))))),
    isSuper() ? h('p', { class: 'small muted' }, 'Como superadmin también puedes administrar los perfiles de todos los negocios en Sistema → Zernio.') : null,
  );
  if (code) history.replaceState(null, '', '#/redes');
  if (code === 'ok') toast(RETURN.ok);
}
