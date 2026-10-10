import { pendingConnections } from './agent-connections.js';
import { agentWizard } from './agentwizard.js';
import { channelIcon, connectionBadge, poolsCard } from './channels.js';
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
  const createBox = agentWizard({ hidden: params.get('new') !== '1' });
  const noAccounts = isSuper() && !state.accounts.length;
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Agentes'),
      h('button', { class: 'primary', disabled: noAccounts, onclick: () => (createBox.hidden = !createBox.hidden) }, '+ Crear agente')),
    noAccounts ? h('div', { class: 'card' }, h('p', {}, 'Primero crea una cuenta (cliente) en ', h('a', { href: '#/accounts' }, 'Cuentas'), '.')) : null,
    h('p', { class: 'muted' }, 'Crea tu agente, pruébalo y conecta los teléfonos o canales que atenderá.'),
    createBox,
    bots.length || noAccounts ? null : h('div', { class: 'card' }, h('p', {}, 'Aún no hay agentes. Crea el primero para empezar.')),
    h('div', { class: 'grid' },
      bots.map((b) => {
        const s = byId[b.id] || {};
        const mine = channels.filter((c) => c.chatbot_id === b.id);
        return h('div', { class: 'card' },
          h('div', { class: 'row between' },
            h('h3', { style: 'margin:0' }, h('a', { href: `#/bot/${b.id}/general` }, b.name)),
            h('span', { class: `badge ${b.active ? 'green' : ''}` }, b.active ? 'Encendido' : 'Apagado')),
          isSuper() && !state.accountId ? h('p', { class: 'muted small', style: 'margin:4px 0 0' }, accountName(b.account_id)) : null,
          h('p', { class: 'small' }, mine.length ? mine.map((c) => h('a', { class: 'agent-channel', href: `#/bot/${b.id}/conexiones` }, channelIcon(c.type), ' ', c.name, ' ', connectionBadge(c))) : h('span', { class: 'muted' }, 'Sin conexiones · puedes probarlo antes de conectar un teléfono')),
          h('div', { class: 'row', style: 'gap:18px' },
            h('div', {}, h('div', { class: 'kpi' }, s.conversations ?? 0), h('div', { class: 'muted small' }, 'conversaciones')),
            h('div', {}, h('div', { class: 'kpi' }, s.waiting_human ?? 0), h('div', { class: 'muted small' }, 'con humano')),
            h('div', {}, h('div', { class: 'kpi' }, s.messages_24h ?? 0), h('div', { class: 'muted small' }, 'mensajes 24 h')),
          ),
          h('details', { class: 'small' },
            h('summary', {}, 'Uso de IA (30 días)'),
            h('p', { class: 'muted small' },
              `${(s.input_tokens_30d ?? 0).toLocaleString()} tokens de entrada (${(s.cached_tokens_30d ?? 0).toLocaleString()} en caché) · ${(s.output_tokens_30d ?? 0).toLocaleString()} de salida`)),
          s.errors_24h ? h('p', {}, h('a', { href: `#/logs?chatbot_id=${b.id}&level=error` }, h('span', { class: 'badge red' }, `${s.errors_24h} errores en 24 h`))) : null,
          h('div', { class: 'row' },
            h('a', { class: 'btn', href: `#/bot/${b.id}/instrucciones` }, 'Configurar'),
            h('a', { class: 'btn primary', href: `#/bot/${b.id}/conexiones?new=1` }, 'Conectar teléfono'),
            h('a', { class: 'btn', href: `#/bot/${b.id}/probar` }, 'Probar'),
            h('a', { class: 'btn', href: `#/conversations?chatbot_id=${b.id}` }, 'Conversaciones')),
        );
      }),
    ),
    pendingConnections(channels, bots),
  );
  const selected = state.accountId || (!isSuper() ? state.me.account?.id : null);
  const phones = channels.filter((c) => c.account_id === selected && c.type === 'whatsapp');
  if (selected && phones.length >= 2) {
    const content = h('div');
    root.append(h('details', { class: 'card' }, h('summary', {}, 'Enlaces para repartir clientes entre tus teléfonos'), content));
    let loaded = false;
    const details = content.parentElement;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      try { content.replaceChildren(await poolsCard(phones)); }
      catch { loaded = false; content.textContent = 'No se pudo cargar. Cierra y vuelve a abrir para reintentar.'; }
    });
  }
  if (params.get('connections') === '1') root.querySelector('#pending-connections')?.scrollIntoView({ block: 'start' });
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
      tile('#/agentes', '🤖', 'Agentes y conexiones', 'Crea, configura y prueba tus agentes; conecta sus teléfonos y otros canales desde su ficha.'),
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
