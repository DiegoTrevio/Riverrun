import { api, ask, confirmAction, dialog, field, h, run, select, state, toast } from './core.js';
import { icon, networkIcon } from './icons.js';
import { render } from './main.js';
import { isSuper, withAcct } from './session.js';

/**
 * Redes sociales del negocio (por Zernio): las cuentas conectadas, quién contesta los mensajes de cada una y el botón
 * para conectar otra red. El negocio nunca ve llaves ni identificadores de Zernio.
 */

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

/** Lo que permite una red, en palabras simples (con "Conectar con Facebook", los mensajes de Facebook e Instagram van por ahí). */
const can = (n, metaDirect) => [n.dm && !(metaDirect && ['facebook', 'instagram'].includes(n.id)) ? 'mensajes' : null, n.comments ? 'comentarios' : null, n.reviews ? 'reseñas' : null, n.posts ? 'publicaciones' : null, n.analytics ? 'estadísticas' : null].filter(Boolean).join(' · ');

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

  /**
   * WhatsApp oficial, guiado: qué se necesita y si el número sigue en la app WhatsApp Business del teléfono
   * (coexistencia). Devuelve la opción elegida, o null si se canceló.
   */
  const whatsappSteps = async () => {
    const choice = { onboarding: 'business_app' };
    const option = (value, title, help) => h('label', { class: 'check', style: 'align-items:flex-start;margin:8px 0' },
      h('input', { type: 'radio', name: 'wa-onboarding', value, checked: choice.onboarding === value, onchange: () => (choice.onboarding = value) }),
      h('span', {}, h('strong', {}, title), h('br'), h('span', { class: 'small muted' }, help)));
    const ok = await dialog('Conectar WhatsApp Business (API oficial)', h('div', {},
      h('p', {}, 'Vas a iniciar sesión con Facebook y elegir tu número. Ten a la mano:'),
      h('ul', { class: 'small' },
        h('li', {}, 'El celular con el número, para recibir el código de verificación.'),
        h('li', {}, 'Acceso de administrador a la cuenta de Meta Business de tu negocio (o se crea una en el proceso).'),
        h('li', {}, 'Si tu número tiene PIN de verificación en dos pasos, tenlo listo: te lo pediremos después.')),
      h('fieldset', { class: 'field' }, h('legend', {}, '¿Quieres seguir usando la app WhatsApp Business en tu teléfono?'),
        option('business_app', 'Sí, sigo usándola', 'Contestas desde el teléfono y tu agente también responde aquí (los mensajes se ven en los dos lados).'),
        option('api', 'No, solo desde aquí', 'El número queda solo en la API oficial; úsalo si ya está en otra plataforma o es un número nuevo.'))), 'Continuar');
    return ok ? choice.onboarding : null;
  };

  const connect = async (platform, chatbotId = '', reconnect = '') => {
    let onboarding;
    if (platform === 'whatsapp' && !reconnect) {
      onboarding = await whatsappSteps();
      if (!onboarding) return;
    }
    const r = await run(() => api('POST', withAcct('/api/social-accounts/connect'), { platform, chatbot_id: chatbotId || null, ...(reconnect ? { reconnect } : {}), ...(onboarding ? { onboarding } : {}) }));
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
      : h('span', { class: 'net-icon' }, networkIcon(a.platform, 26));
    const agent = a.dm ? h('select', {
      'aria-label': `Quién contesta los mensajes de ${n.label}`,
      onchange: async (e) => { if (await run(() => api('PUT', withAcct(`/api/social-accounts/${a.id}`), { chatbot_id: e.target.value || null }), 'Guardado')) render(); },
    }, h('option', { value: '' }, 'Nadie: solo se guardan'), bots.map((b) => h('option', { value: b.id, selected: a.chatbot_id === b.id }, b.name))) : null;
    return h('div', { class: 'list-item' },
      h('div', { class: 'row', style: 'gap:12px;align-items:center' }, avatar,
        h('div', { style: 'flex:1;min-width:0' },
          h('strong', {}, a.display_name || a.username || n.label),
          h('div', { class: 'small muted' }, n.label, a.username ? ` · @${a.username}` : ''),
          h('span', { class: `badge ${color}` }, label),
          a.status === 'active' && a.health?.problem ? h('div', { class: 'small stats-warn' }, icon('alert', 14), ' ', a.health.problem) : null),
        h('div', { class: 'row' },
          a.status !== 'active' || a.health?.reconnect ? h('button', { class: 'small primary', onclick: () => connect(a.platform, a.chatbot_id, a.id) }, 'Reconectar') : null,
          a.platform === 'whatsapp' ? h('a', { class: 'btn small', href: `#/redes/whatsapp/${a.id}` }, 'Plantillas') : null,
          a.platform === 'whatsapp' ? h('button', { class: 'small', title: 'Si tu número tiene verificación en dos pasos y no salen los mensajes', onclick: async () => {
            const pin = await ask('PIN de verificación en dos pasos de tu número (6 dígitos)', '', { title: 'PIN de WhatsApp', accept: 'Registrar' });
            if (pin === null) return;
            await run(() => api('POST', withAcct(`/api/social-accounts/${a.id}/whatsapp-pin`), { pin: pin.trim() }), 'Número registrado con tu PIN');
          } }, 'PIN') : null,
          h('button', { class: 'small danger', onclick: async () => {
            if (!(await confirmAction(`¿Desconectar ${n.label}${a.username ? ` (@${a.username})` : ''}? Dejarás de recibir sus mensajes y comentarios aquí.`))) return;
            if (await run(() => api('POST', withAcct(`/api/social-accounts/${a.id}/disconnect`)), 'Desconectada')) render();
          } }, 'Desconectar'))),
      a.dm ? field('Contesta sus mensajes', agent, a.chatbot_id ? 'Tu agente responde los mensajes directos de esta cuenta.' : 'Elige un agente para que conteste los mensajes directos.') : null,
      n.comments || n.reviews ? commentSettings(a, n) : null);
  };

  /** Comentarios y reseñas de la cuenta: qué hace la IA y cómo avisa al equipo. */
  const commentSettings = (a, n) => {
    const s = { mode: 'suggest', chatbot_id: '', max_per_hour: 10, alerts: 'digest', ...(a.comment_settings || {}) };
    s.chatbot_id = s.chatbot_id || '';
    const what = n.comments && n.reviews ? 'comentarios y reseñas' : n.comments ? 'comentarios' : 'reseñas';
    return h('details', { class: 'social-comments-settings', style: 'margin-top:8px' },
      h('summary', {}, `Respuestas a ${what}`),
      h('div', { class: 'stack', style: 'margin-top:8px' },
        field('La IA', select(s, 'mode', [['suggest', 'Sugiere la respuesta cuando la pides'], ['auto', 'Contesta sola lo positivo (lo demás te lo deja)'], ['off', 'No hace nada: solo se guardan']]),
          'Nunca contesta sola quejas, reseñas de 3 estrellas o menos, mensajes delicados ni lo que lleva más de 7 días.'),
        field('Con la información y el estilo de', select(s, 'chatbot_id', [['', 'El agente de esta cuenta (o el primero)'], ...bots.map((b) => [b.id, b.name])])),
        field('Máximo de respuestas automáticas por hora', h('input', { type: 'number', min: 1, max: 30, value: s.max_per_hour, oninput: (e) => (s.max_per_hour = Number(e.target.value) || 1) })),
        field('Avisos al equipo', select(s, 'alerts', [['digest', 'Un resumen cada 15 minutos con lo nuevo'], ['off', 'Sin resumen (las reseñas malas siempre avisan)']])),
        h('div', { class: 'row' },
          h('button', { class: 'small', onclick: () => run(() => api('PUT', withAcct(`/api/social-accounts/${a.id}/comment-settings`), { ...s, chatbot_id: s.chatbot_id || null }), 'Guardado') }, 'Guardar'),
          h('a', { href: `#/comentarios?red=${encodeURIComponent(a.platform)}`, class: 'small' }, 'Ver comentarios →'))));
  };

  root.append(
    h('h1', {}, 'Redes sociales'),
    h('p', { class: 'muted' }, 'Conecta las redes de tu negocio. En las que tienen mensajes directos tu agente puede contestar; tú inicias sesión en cada red y autorizas el acceso.'),
    notice,
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Tus redes conectadas'),
      data.accounts.length ? data.accounts.map(accountCard) : h('p', { class: 'muted' }, 'Todavía no conectas ninguna red.'),
      data.limit?.max ? h('p', { class: 'small muted', style: 'margin-bottom:0' }, `Usas ${data.limit.used} de ${data.limit.max} redes que incluye tu plan.`) : null,
      data.accounts.length ? h('p', { class: 'small', style: 'margin-bottom:0' }, h('a', { href: '#/estadisticas/redes' }, 'Ver sus estadísticas →')) : null),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Conectar otra red'),
      data.meta_direct ? h('p', { class: 'small muted' }, 'Facebook e Instagram ya se conectan con el botón "Conectar con Facebook" en las conexiones de tu agente; aquí solo se usan para comentarios, publicaciones y estadísticas.') : null,
      h('div', { class: 'grid' }, networks.map((n) => h('button', { class: 'social-network', onclick: () => connect(n.id) },
        h('span', { class: 'net-icon' }, networkIcon(n.id, 22)),
        h('span', {}, h('strong', {}, n.label), h('br'), h('span', { class: 'small muted' }, can(n, data.meta_direct))))))),
    isSuper() ? h('p', { class: 'small muted' }, 'Como superadmin también puedes administrar los perfiles de todos los negocios en Sistema → Zernio.') : null,
  );
  if (code) history.replaceState(null, '', '#/redes');
  if (code === 'ok') toast(RETURN.ok);
}
