import { channelIcon } from './channels.js';
import { api, area, field, h, run, select, state, text, toast } from './core.js';
import { accountName, acct, isSuper } from './session.js';

/** Selector de cuenta al crear algo (solo superadmin; los demás usan la suya). */
export function accountPicker(obj) {
  if (!isSuper()) return null;
  if (!obj.account_id) obj.account_id = state.accountId || state.accounts[0]?.id || '';
  return field('Perfil asignado', select(obj, 'account_id', state.accounts.map((a) => [a.id, a.name])));
}

/* ------------------------------ Dashboard ------------------------------ */

export async function viewDashboard(root, params = new URLSearchParams()) {
  const [bots, stats, channels] = await Promise.all([api('GET', `/api/chatbots${acct()}`), api('GET', `/api/stats${acct()}`), api('GET', `/api/channels${acct()}`)]);
  state.bots = bots;
  const byId = Object.fromEntries(stats.chatbots.map((s) => [s.id, s]));
  const nb = { name: '', template: state.me.account?.business_type || 'otro', setup: { goal: '', questions: '', knowledge: '' } };
  const createBox = h('div', { class: 'card', hidden: params.get('new') !== '1' },
    h('h3', { style: 'margin-top:0' }, 'Crea tu agente'),
    h('p', { class: 'muted' }, 'Describe tu negocio y qué necesitas conseguir. Organizamos las instrucciones y guardamos las respuestas automáticamente.'),
    accountPicker(nb),
    h('h4', {}, '1. Tu negocio'),
    h('div', { class: 'grid' },
      field('Nombre del negocio', text(nb, 'name', { placeholder: 'Los Trompitos', maxlength: 120 })),
      field('Tipo de negocio', select(nb, 'template', (state.meta.business_types || []).map((b) => [b.key, b.label])))),
    field('Información para responder', area(nb.setup, 'knowledge', { placeholder: 'Qué vendes, precios, horarios, ubicación y condiciones.', maxlength: 50000 }), 'Puedes pegar la información que ya tienes. Después podrás agregar documentos y fotos.'),
    h('h4', {}, '2. Qué debe lograr'),
    field('Objetivo', area(nb.setup, 'goal', { placeholder: 'Completar el pedido y pasarlo al equipo para confirmarlo.', maxlength: 2000 })),
    h('h4', {}, '3. Qué debe preguntar'),
    field('Preguntas clave', area(nb.setup, 'questions', { placeholder: 'Qué quiere pedir, cantidad y si recoge o necesita entrega. Para entrega: nombre y dirección.', maxlength: 4000 }), 'Escríbelas con tus palabras. El agente preguntará una a la vez y guardará las respuestas sin crear campos.'),
    h('p', { class: 'help' }, 'Se crea apagado para que puedas probarlo antes de conectarlo a tus teléfonos.'),
    h('button', { class: 'primary', onclick: async (event) => {
      if (!nb.name.trim() || !nb.setup.goal.trim() || !nb.setup.questions.trim() || !nb.setup.knowledge.trim()) return toast('Completa el nombre, la información, el objetivo y las preguntas clave.', true);
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const bot = await run(() => api('POST', '/api/chatbots', nb));
        if (bot) location.hash = `#/bot/${bot.id}/probar`;
      } finally { button.disabled = false; }
    } }, 'Crear y probar'));
  const noAccounts = isSuper() && !state.accounts.length;
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Asistentes'),
      h('button', { class: 'primary', disabled: noAccounts, onclick: () => (createBox.hidden = !createBox.hidden) }, '+ Nuevo asistente')),
    noAccounts ? h('div', { class: 'card' }, h('p', {}, 'Primero crea una cuenta (cliente) en ', h('a', { href: '#/accounts' }, 'Cuentas'), '.')) : null,
    createBox,
    bots.length || noAccounts ? null : h('div', { class: 'card' }, h('p', {}, 'Aún no hay asistentes. Crea el primero para empezar.')),
    h('div', { class: 'grid' },
      bots.map((b) => {
        const s = byId[b.id] || {};
        const mine = channels.filter((c) => c.chatbot_id === b.id);
        return h('div', { class: 'card' },
          h('div', { class: 'row between' },
            h('h3', { style: 'margin:0' }, h('a', { href: `#/bot/${b.id}/general` }, b.name)),
            h('span', { class: `badge ${b.active ? 'green' : ''}` }, b.active ? 'Encendido' : 'Apagado')),
          isSuper() && !state.accountId ? h('p', { class: 'muted small', style: 'margin:4px 0 0' }, accountName(b.account_id)) : null,
          h('p', { class: 'small' }, mine.length ? mine.map((c) => h('span', { class: 'badge', style: 'margin-right:4px' }, channelIcon(c.type), ' ', c.name)) : h('span', { class: 'muted' }, 'Sin canales')),
          h('div', { class: 'row', style: 'gap:18px' },
            h('div', {}, h('div', { class: 'kpi' }, s.conversations ?? 0), h('div', { class: 'muted small' }, 'conversaciones')),
            h('div', {}, h('div', { class: 'kpi' }, s.waiting_human ?? 0), h('div', { class: 'muted small' }, 'con humano')),
            h('div', {}, h('div', { class: 'kpi' }, s.messages_24h ?? 0), h('div', { class: 'muted small' }, 'mensajes 24 h')),
          ),
          h('p', { class: 'muted small' },
            `Tokens 30 días: ${(s.input_tokens_30d ?? 0).toLocaleString()} entrada (${(s.cached_tokens_30d ?? 0).toLocaleString()} en caché) · ${(s.output_tokens_30d ?? 0).toLocaleString()} salida`),
          s.errors_24h ? h('p', {}, h('a', { href: `#/logs?chatbot_id=${b.id}&level=error` }, h('span', { class: 'badge red' }, `${s.errors_24h} errores en 24 h`))) : null,
          h('div', { class: 'row' },
            h('a', { class: 'btn', href: `#/bot/${b.id}/probar` }, 'Probar'),
            h('a', { class: 'btn', href: `#/conversations?chatbot_id=${b.id}` }, 'Conversaciones')),
        );
      }),
    ),
  );
}

/** "Mi asistente" y "Probar": abren el asistente principal de la cuenta (el más antiguo). */
export async function goMainBot(root, tab) {
  const bots = await api('GET', `/api/chatbots${acct()}`);
  if (!bots.length) { location.hash = '#/inicio'; return; }
  location.replace(`#/bot/${bots[0].id}/${tab}`);
}

/** Ajustes: todo lo que no es el día a día, con una explicación de una línea. */
export async function viewSettingsHub(root) {
  const tile = (href, icon, title, text) => h('a', { class: 'card tile', href }, h('div', { style: 'font-size:28px' }, icon), h('h3', { style: 'margin:6px 0' }, title), h('p', { class: 'muted small', style: 'margin:0' }, text));
  root.append(
    h('h1', {}, 'Ajustes'),
    h('div', { class: 'grid' },
      tile('#/conectar', '📲', 'Conectar WhatsApp', 'Escanea el código QR para vincular el WhatsApp de tu negocio (o cámbialo por otro número).'),
      tile('#/channels', '📱', 'Canales', 'Conecta o desconecta tu WhatsApp, Telegram, Instagram, Messenger o el chat de tu sitio web.'),
      tile('#/automation/settings', '🕘', 'Horario y avisos', 'Tu horario de atención, zona horaria y a quién avisar.'),
      tile('#/agenda/servicios', '🗓️', 'Servicios y citas', 'Qué servicios agenda tu asistente y cuánto dura cada uno.'),
      tile('#/automation', '⚡', 'Respuestas automáticas', 'Recordatorios, seguimientos y campañas a tus clientes.'),
      tile('#/integraciones', '🔌', 'Integraciones', 'Google Calendar, webhooks para Zapier/Make y llaves de la API.'),
      tile('#/users', '👥', 'Mi equipo', 'Invita a quienes atienden las conversaciones contigo.'),
      tile('#/plan', '💳', 'Mi plan y pagos', 'Tu plan, próximo cobro, forma de pago y facturas.'),
      tile('#/consumo', '📊', 'Consumo', 'Cuánto ha usado tu asistente este mes.'),
      tile('#/logs', '🛠️', 'Registros', 'Si algo falla, aquí se ve qué pasó.'),
      tile('#/password', '🔑', 'Mi perfil', 'Tu nombre, correo y contraseña.')),
    h('p', { class: 'muted small' }, 'Si prefieres ver todas las opciones del panel, usa "☰ Mostrar todas las opciones" en el menú.'),
  );
}
