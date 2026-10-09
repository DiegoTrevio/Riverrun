import { agentWizard } from './agentwizard.js';
import { channelIcon } from './channels.js';
import { api, area, field, h, run, select, state, text, toast } from './core.js';
import { icon } from './icons.js';
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
  const createBox = agentWizard({ hidden: params.get('new') !== '1' });
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
  const tile = (href, name, title, text) => h('a', { class: 'card tile', href }, h('span', { class: 'tile-ico' }, icon(name)), h('h3', {}, title), h('p', { class: 'muted small' }, text));
  root.append(
    h('h1', {}, 'Ajustes'),
    h('div', { class: 'grid' },
      tile('#/conectar', 'smartphone', 'Conectar WhatsApp', 'Escanea el código QR para vincular el WhatsApp de tu negocio (o cámbialo por otro número).'),
      tile('#/channels', 'plug', 'Canales', 'Conecta o desconecta tu WhatsApp, Telegram, Instagram, Messenger o el chat de tu sitio web.'),
      tile('#/automation/settings', 'clock', 'Horario y avisos', 'Tu horario de atención, zona horaria y a quién avisar.'),
      tile('#/agenda/servicios', 'calendar', 'Servicios y citas', 'Qué servicios agenda tu asistente y cuánto dura cada uno.'),
      tile('#/automation', 'zap', 'Respuestas automáticas', 'Recordatorios, seguimientos y campañas a tus clientes.'),
      tile('#/integraciones', 'link', 'Integraciones', 'Google Calendar, webhooks para Zapier/Make y llaves de la API.'),
      tile('#/users', 'users', 'Mi equipo', 'Invita a quienes atienden las conversaciones contigo.'),
      tile('#/plan', 'card', 'Mi plan y pagos', 'Tu plan, próximo cobro, forma de pago y facturas.'),
      tile('#/consumo', 'chart', 'Consumo', 'Cuánto ha usado tu asistente este mes.'),
      tile('#/logs', 'list', 'Registros', 'Si algo falla, aquí se ve qué pasó.'),
      tile('#/password', 'user', 'Mi perfil', 'Tu nombre, correo y contraseña.')),
    h('p', { class: 'muted small' }, 'Si prefieres ver todas las opciones del panel, usa "Mostrar todas las opciones" en el menú.'),
  );
}
