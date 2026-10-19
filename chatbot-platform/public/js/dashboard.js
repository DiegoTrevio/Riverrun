import { pendingConnections } from './agent-connections.js';
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

export async function viewDashboard(root, params = new URLSearchParams(), home = false) {
  const [bots, stats, channels] = await Promise.all([api('GET', `/api/chatbots${acct()}`), api('GET', `/api/stats${acct()}`).catch(() => null), api('GET', `/api/channels${acct()}`)]);
  if (!root.isConnected) return;
  // Al entrar sin agentes (p. ej. recién registrado con Google), directo a crear el primero.
  if (home && !bots.length && !isSuper()) { location.replace('#/agentes/nuevo'); return; }
  state.bots = bots;
  const byId = Object.fromEntries((stats?.chatbots || []).map((s) => [s.id, s]));
  const noAccounts = isSuper() && !state.accounts.length;
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Agentes'),
      noAccounts ? h('button', { class: 'primary', disabled: true }, '+ Crear agente') : h('a', { class: 'btn primary', href: '#/agentes/nuevo' }, '+ Crear agente')),
    noAccounts ? h('div', { class: 'card' }, h('p', {}, 'Primero crea una cuenta (cliente) en ', h('a', { href: '#/accounts' }, 'Cuentas'), '.')) : null,
    h('p', { class: 'muted' }, 'Crea tu agente, pruébalo y conecta los teléfonos o canales que atenderá.'),
    stats ? null : h('div', { class: 'banner warn', role: 'status' }, 'No pudimos cargar las estadísticas. Puedes configurar tus agentes; vuelve a entrar para actualizar las cifras.'),
    bots.length || noAccounts ? null : h('div', { class: 'card' }, h('p', {}, 'Aún no tienes agentes. Créalo en 3 pasos: cuéntale de tu negocio, elige qué hará y conéctalo a tu WhatsApp.'), h('a', { class: 'btn primary', href: '#/agentes/nuevo' }, 'Crear mi agente')),
    h('div', { class: 'grid' },
      bots.map((b) => {
        const s = byId[b.id] || {};
        const mine = channels.filter((c) => c.chatbot_id === b.id);
        return h('div', { class: 'card' },
          h('div', { class: 'row between' },
            h('h2', { style: 'margin:0' }, h('a', { href: `#/bot/${b.id}/general` }, b.name)),
            h('span', { class: `badge ${b.active ? 'green' : ''}` }, b.active ? 'Encendido' : b.start_on_connect ? 'Se enciende al conectar' : 'Apagado')),
          isSuper() && !state.accountId ? h('p', { class: 'muted small', style: 'margin:4px 0 0' }, accountName(b.account_id)) : null,
          h('p', { class: 'small' }, mine.length ? mine.map((c) => h('a', { class: 'agent-channel', href: `#/bot/${b.id}/conexiones/${c.id}` }, channelIcon(c.type, c.config?.platform), ' ', c.name, ' ', connectionBadge(c))) : h('span', { class: 'muted' }, 'Sin conexiones · puedes probarlo antes de conectar un teléfono')),
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
            // Sin WhatsApp todavía: a la página que lo prueba y lo conecta en un paso.
            h('a', { class: 'btn primary', href: mine.some((c) => c.type === 'whatsapp') ? `#/bot/${b.id}/conexiones?new=1` : `#/bot/${b.id}/empezar` }, 'Conectar teléfono'),
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
  if (!root.isConnected) return;
  if (!bots.length) { location.hash = '#/agentes/nuevo'; return; }
  location.replace(`#/bot/${bots[0].id}/${tab}`);
}

/** Ajustes: todo lo que no es el día a día, con una explicación de una línea. */
export async function viewSettingsHub(root) {
  const tile = (href, icon, title, text) => h('a', { class: 'card tile', href }, h('div', { style: 'font-size:28px' }, icon), h('h2', { style: 'margin:6px 0' }, title), h('p', { class: 'muted small', style: 'margin:0' }, text));
  root.append(
    h('h1', {}, 'Resumen de ajustes'),
    h('div', { class: 'grid' },
      tile('#/agentes', '🤖', 'Agentes y conexiones', 'Crea, configura y prueba tus agentes; conecta sus teléfonos y otros canales desde su ficha.'),
      tile('#/automation/settings', '🕘', 'Horario y avisos', 'Tu horario de atención, zona horaria y a quién avisar.'),
      tile('#/agenda/servicios', '🗓️', 'Servicios y citas', 'Qué servicios agenda tu asistente y cuánto dura cada uno.'),
      tile('#/automation', '⚡', 'Respuestas automáticas', 'Recordatorios, seguimientos y campañas a tus clientes.'),
      tile('#/integraciones', '🔌', 'Integraciones', 'Google Calendar, webhooks para Zapier/Make y llaves de la API.'),
      tile('#/users', '👥', 'Mi equipo', 'Crea usuarios para quienes atienden las conversaciones contigo.'),
      !isSuper() ? tile('#/plan', '💳', 'Mi plan y pagos', 'Tu plan, próximo cobro, forma de pago y facturas.') : null,
      tile('#/consumo', '📊', 'Consumo', 'Cuánto ha usado tu asistente este mes.'),
      tile('#/logs', '🛠️', 'Registros', 'Si algo falla, aquí se ve qué pasó.'),
      tile('#/password', '🔑', 'Mi perfil', 'Tu nombre, correo y contraseña.')),
  );
}
