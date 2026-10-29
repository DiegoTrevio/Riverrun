import { pendingConnections } from './agent-connections.js';
import { channelIcon, connectionBadge, connectionHref, networkLabel, poolsCard } from './channels.js';
import { ago, api, area, field, fmtPhone, h, initialsOf, personTint, run, select, state, text, toast } from './core.js';
import { icon } from './icons.js';
import { accountName, acct, isAdmin, isSuper, withAcct } from './session.js';

/** Selector de cuenta al crear algo (solo superadmin; los demás usan la suya). */
export function accountPicker(obj) {
  if (!isSuper()) return null;
  if (!obj.account_id) obj.account_id = state.accountId || state.accounts[0]?.id || '';
  return field('Perfil asignado', select(obj, 'account_id', state.accounts.map((a) => [a.id, a.name])));
}

/* ------------------------------ Dashboard ------------------------------ */

/** Tarjeta «Para empezar»: lo que le falta a la cuenta para que su agente atienda y quede contratado. */
function checklistCard(list) {
  if (!list?.show) return null;
  const card = h('section', { class: 'card checklist', 'aria-labelledby': 'checklist-title' },
    h('div', { class: 'row between' },
      h('h2', { id: 'checklist-title', style: 'margin:0' }, 'Para empezar'),
      h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/onboarding/step${acct()}`, { step: 'hide_checklist' }))) card.remove(); } }, 'Ocultar')),
    h('p', { class: 'muted small' }, `${list.done_count} de ${list.total} pasos listos`),
    h('progress', { max: list.total, value: list.done_count, 'aria-label': `${list.done_count} de ${list.total} pasos listos` }),
    h('ol', { class: 'checklist-items' }, list.items.map((i) => h('li', { class: i.done ? 'done' : '' },
      h('span', { class: 'check', 'aria-hidden': 'true' }, i.done ? icon('check', 14) : ''),
      h('div', {},
        h('strong', {}, i.label), i.optional ? h('span', { class: 'muted small' }, ' (opcional)') : null, i.done ? h('span', { class: 'sr-only' }, ' (listo)') : null,
        i.done ? null : h('p', { class: 'muted small' }, i.hint)),
      i.done ? null : i.href ? h('a', { class: 'btn small', href: i.href }, i.action)
        : h('button', { class: 'small', onclick: () => run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace') }, i.action)))));
  return card;
}

/** Una conexión del agente como fila: su ícono, su nombre, el número (o el tipo) y su estado. */
function phoneRow(bot, c) {
  const detail = c.type === 'whatsapp' ? (c.config?.number ? [fmtPhone(c.config.number), c.config.profile_name ? ` · ${c.config.profile_name}` : ''] : 'Sin número vinculado todavía')
    : c.type === 'zernio' ? networkLabel(c.config?.platform) + (c.config?.username ? ` · @${c.config.username}` : '') : c.label || c.type;
  const down = c.type === 'whatsapp' && c.active && c.connection_state !== 'open';
  return h('li', {},
    channelIcon(c.type, c.config?.platform),
    h('a', { class: 'name', href: connectionHref(c) }, c.name),
    h('span', { class: 'state' }, connectionBadge(c), down ? h('a', { class: 'btn small', href: connectionHref(c) }, 'Conectar') : null),
    h('span', { class: 'detail' }, detail));
}

/** Un agente: lo que pasó hoy (una franja dividida), sus teléfonos y canales, y el siguiente paso si falta uno. */
function agentPanel(b, s, mine) {
  const live = mine.some((c) => c.active && (c.type === 'whatsapp' ? c.connection_state === 'open' : c.type === 'zernio' ? !!c.config?.account_id && c.connection_state !== 'close' : c.connection_state !== 'close'));
  // El siguiente paso, uno solo y en lenguaje simple. Sin WhatsApp todavía: a la página que lo prueba y lo conecta.
  const connect = mine.some((c) => c.type === 'whatsapp') ? `#/bot/${b.id}/conexiones?new=1` : `#/bot/${b.id}/empezar`;
  const next = !live ? [b.start_on_connect ? 'Conecta tu WhatsApp: se enciende solo al conectarlo.' : 'Conecta WhatsApp u otro canal para que empiece a atender.', connect, 'Conectar']
    : !b.active ? ['Está en pausa: no responde a tus clientes.', `#/bot/${b.id}/instrucciones`, 'Encenderlo'] : null;
  const waiting = s.waiting_human ?? 0;
  const who = b.personality?.assistant_name;
  return h('section', { class: 'card agent-panel', 'aria-labelledby': `agent-${b.id}` },
    h('div', { class: 'agent-panel-head' },
      h('div', {},
        h('h2', { id: `agent-${b.id}` }, h('a', { href: `#/bot/${b.id}/instrucciones` }, b.name)),
        h('p', { class: 'sub' }, [who ? `Atiende como ${who}` : 'Asistente con IA', isSuper() && !state.accountId ? ` · ${accountName(b.account_id)}` : ''].join(''))),
      h('span', { class: `badge ${b.active ? 'green' : ''}` }, b.active ? 'Encendido' : b.start_on_connect ? 'Se enciende al conectar' : 'En pausa')),
    h('div', { class: 'kpi-strip' },
      h('div', {}, h('span', { class: 'label' }, 'Mensajes atendidos'), h('span', { class: 'value' }, String(s.messages_24h ?? 0)), h('span', { class: 'cap' }, 'en las últimas 24 h')),
      h('div', {}, h('span', { class: 'label' }, 'Conversaciones'), h('span', { class: 'value' }, String(s.conversations ?? 0)), h('span', { class: 'cap' }, 'desde que empezó')),
      h('div', {}, h('span', { class: 'label' }, 'Esperan a una persona'),
        h('span', { class: `value${waiting ? ' alert' : ''}` }, waiting ? h('a', { href: `#/conversations?chatbot_id=${b.id}&status=human` }, String(waiting)) : '0'),
        h('span', { class: 'cap' }, waiting ? 'ahora mismo' : 'nadie por ahora'))),
    next ? h('p', { class: 'banner warn agent-panel-note', style: 'margin-top:16px' }, next[0], ' ', h('a', { href: next[1] }, next[2])) : null,
    s.errors_24h ? h('p', { class: 'banner danger agent-panel-note', style: 'margin-top:16px' }, `${s.errors_24h} ${s.errors_24h === 1 ? 'error' : 'errores'} en las últimas 24 h. `, h('a', { href: `#/logs?chatbot_id=${b.id}&level=error` }, 'Ver qué pasó')) : null,
    mine.length ? h('ul', { class: 'phone-list', 'aria-label': `Conexiones de ${b.name}` }, mine.map((c) => phoneRow(b, c)))
      : h('p', { class: 'agent-panel-note muted', style: 'margin-top:16px' }, 'Todavía no tiene teléfono ni canales. ', h('a', { href: `#/bot/${b.id}/empezar` }, 'Conectar mi WhatsApp')),
    h('div', { class: 'agent-panel-foot' },
      h('a', { class: 'btn small', href: `#/bot/${b.id}/instrucciones` }, 'Configurar'),
      h('a', { class: 'btn small ghost', href: `#/bot/${b.id}/probar` }, 'Probar'),
      h('a', { class: 'btn small ghost', href: `#/conversations?chatbot_id=${b.id}` }, 'Conversaciones'),
      h('a', { class: 'btn small ghost', href: `#/bot/${b.id}/conexiones?new=1` }, 'Conectar otro canal')));
}

/** Cola de la derecha: quienes esperan a una persona, la espera más larga primero, con «Atender» a un clic. */
function waitingRail(waiting) {
  const rows = [...waiting].sort((a, b) => new Date(a.last_message_at) - new Date(b.last_message_at)).slice(0, 5);
  return h('aside', { class: 'rail wait', 'aria-labelledby': 'queue-title' },
    h('h2', { id: 'queue-title' }, 'Esperan a una persona'),
    h('div', { class: 'card' },
      rows.length
        ? h('ul', { class: 'queue' }, rows.map((c) => {
          const name = c.name || c.push_name || fmtPhone(c.phone) || 'Cliente';
          return h('li', {}, h('a', { href: `#/conversation/${c.id}` },
            h('span', { class: 'mini-avatar person', style: personTint(c.contact_id || c.id), 'aria-hidden': 'true' }, initialsOf(name)),
            h('strong', {}, name),
            h('time', { datetime: c.last_message_at }, ago(c.last_message_at)),
            h('span', { class: 'why' }, c.handoff_reason || c.last_message || 'Pidió hablar con alguien del equipo'),
            h('span', { class: 'go' }, 'Atender')));
        }))
        : h('p', { class: 'queue-empty' }, 'Nadie espera a una persona. Tu agente está atendiendo.'),
      waiting.length > rows.length ? h('div', { class: 'rail-foot' }, h('a', { href: '#/conversations?status=human' }, `Ver las ${waiting.length} que esperan`)) : null));
}

/** Lo último que pasó: las conversaciones más recientes que el agente lleva solo, con su último mensaje. */
function recentRail(recent) {
  const rows = recent.filter((c) => c.status !== 'human').slice(0, 4);
  if (!rows.length) return null;
  return h('section', { class: 'rail recent', 'aria-labelledby': 'recent-title' },
    h('h2', { id: 'recent-title' }, 'Últimas conversaciones'),
    h('div', { class: 'card' },
      h('ul', { class: 'queue recent' }, rows.map((c) => {
        const name = c.name || c.push_name || fmtPhone(c.phone) || 'Cliente';
        const said = c.last_message ? `${c.last_direction === 'out' ? 'Respondió: ' : ''}${c.last_message}` : 'Sin mensajes todavía';
        return h('li', {}, h('a', { href: `#/conversation/${c.id}` },
          h('span', { class: 'mini-avatar person', style: personTint(c.contact_id || c.id), 'aria-hidden': 'true' }, initialsOf(name)),
          h('strong', {}, name),
          h('time', { datetime: c.last_message_at || c.created_at }, ago(c.last_message_at || c.created_at)),
          h('span', { class: 'why' }, said)));
      })),
      h('div', { class: 'rail-foot' }, h('a', { href: '#/conversations' }, 'Ver todas las conversaciones'))));
}

export async function viewDashboard(root, params = new URLSearchParams(), home = false) {
  const [bots, stats, channels, checklist, waiting, recent] = await Promise.all([api('GET', `/api/chatbots${acct()}`), api('GET', `/api/stats${acct()}`).catch(() => null), api('GET', `/api/channels${acct()}`),
    isAdmin() && !isSuper() ? api('GET', '/api/onboarding/checklist').catch(() => null) : null,
    api('GET', withAcct('/api/conversations?status=human&limit=50')).catch(() => []),
    api('GET', withAcct('/api/conversations?limit=8')).catch(() => [])]);
  if (!root.isConnected) return;
  // Al entrar sin agentes (p. ej. recién registrado con Google), directo a crear el primero.
  if (home && !bots.length && !isSuper()) { location.replace('#/agentes/nuevo'); return; }
  state.bots = bots;
  const byId = Object.fromEntries((stats?.chatbots || []).map((s) => [s.id, s]));
  const noAccounts = isSuper() && !state.accounts.length;
  const handled = (stats?.chatbots || []).reduce((n, s) => n + (s.messages_24h ?? 0), 0);
  const waitingCount = waiting.length;
  const anyLive = channels.some((c) => c.active && c.chatbot_id && (c.type === 'whatsapp' ? c.connection_state === 'open' : c.connection_state !== 'close'));
  // El hallazgo del día, en una línea bajo el título: quién espera, o que todo está atendido.
  const finding = !bots.length ? 'Tu agente atiende a tus clientes por WhatsApp y otras redes.'
    : waitingCount ? [h('strong', {}, `${waitingCount} ${waitingCount === 1 ? 'cliente espera' : 'clientes esperan'} a una persona`), ` · ${handled} mensajes atendidos en las últimas 24 h`]
      : anyLive ? [h('strong', {}, 'Todo atendido'), `: ${handled} mensajes respondidos en las últimas 24 h.`]
        : 'Tu agente todavía no atiende: conecta tu WhatsApp para que empiece.';
  const create = noAccounts ? h('button', { disabled: true }, 'Crear agente') : h('a', { class: `btn${waitingCount ? '' : ' primary'}`, href: '#/agentes/nuevo' }, 'Crear agente');
  // Columna principal: un panel por agente, las conexiones sin agente y (abajo) los enlaces para repartir clientes.
  const main = h('div', { class: 'overview-main' }, bots.map((b) => agentPanel(b, byId[b.id] || {}, channels.filter((c) => c.chatbot_id === b.id))), pendingConnections(channels, bots));
  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Agentes'), h('p', { class: 'finding' }, finding)),
      h('div', { class: 'row' }, waitingCount ? h('a', { class: 'btn primary', href: '#/conversations?status=human' }, 'Atender a quien espera') : null, create)),
    checklistCard(checklist),
    noAccounts ? h('div', { class: 'card' }, h('p', {}, 'Primero crea una cuenta (cliente) en ', h('a', { href: '#/accounts' }, 'Cuentas'), '.')) : null,
    stats ? null : h('div', { class: 'banner warn', role: 'status', style: 'margin-bottom:24px' }, 'No pudimos cargar las cifras de hoy. Puedes configurar tus agentes; vuelve a entrar para actualizarlas.'),
    bots.length || noAccounts ? null : h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Crea tu primer agente'), h('p', {}, 'Créalo en 3 pasos: cuéntale de tu negocio, elige qué hará y conéctalo a tu WhatsApp.'), h('a', { class: 'btn primary', href: '#/agentes/nuevo' }, 'Crear mi agente')),
    // En el celular la cola va primero (lo urgente), luego los agentes y al final lo reciente.
    bots.length ? h('div', { class: 'overview' }, main, waitingRail(waiting), recentRail(recent)) : main,
  );
  const selected = state.accountId || (!isSuper() ? state.me.account?.id : null);
  const phones = channels.filter((c) => c.account_id === selected && c.type === 'whatsapp');
  if (selected && phones.length >= 2) {
    const content = h('div');
    main.append(h('details', { class: 'card' }, h('summary', {}, 'Enlaces para repartir clientes entre tus teléfonos'), content));
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
  // Filas (ícono de línea, título, una línea y una flecha): cada una abre su propia vista.
  const tile = (href, iconName, title, desc) => h('a', { class: 'tile', href }, icon(iconName), h('strong', {}, title), h('span', { class: 'desc' }, desc), h('span', { class: 'chev' }, icon('chevron-right', 16)));
  root.append(
    h('h1', {}, 'Ajustes'),
    h('p', { class: 'muted', style: 'margin:0 0 24px' }, 'Todo lo que no es el día a día: tu negocio, tu equipo, tu plan y tu cuenta.'),
    h('div', { class: 'settings-index' },
      tile('#/agentes', 'bot', 'Agentes y conexiones', 'Crea, configura y prueba tus agentes; conecta sus teléfonos y otros canales.'),
      tile('#/automation/settings', 'clock', 'Horario y avisos', 'Tu horario de atención, zona horaria y a quién avisar.'),
      tile('#/agenda/servicios', 'calendar', 'Servicios y citas', 'Qué servicios agenda tu asistente y cuánto dura cada uno.'),
      tile('#/automation', 'zap', 'Respuestas automáticas', 'Recordatorios, seguimientos y campañas a tus clientes.'),
      tile('#/integraciones', 'plug', 'Integraciones', 'Google Calendar, webhooks para Zapier o Make y llaves de la API.'),
      tile('#/users', 'contacts', 'Mi equipo', 'Usuarios para quienes atienden las conversaciones contigo.'),
      tile('#/datos-clientes', 'user', 'Datos de tus clientes', 'Lo que guardas de cada cliente (cumpleaños, número de cliente…), para su ficha y tus mensajes.'),
      !isSuper() ? tile('#/plan', 'card', 'Mi plan y pagos', 'Tu plan, próximo cobro, forma de pago y facturas.') : null,
      tile('#/consumo', 'chart', 'Consumo', 'Cuánto ha usado tu asistente este mes.'),
      tile('#/logs', 'wrench', 'Registros', 'Si algo falla, aquí se ve qué pasó.'),
      tile('#/password', 'key', 'Mi perfil', 'Tu nombre, correo y contraseña.')),
  );
}
