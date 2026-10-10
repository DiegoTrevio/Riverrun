import { saveBar } from './bot.js';
import { api, area, check, clone, field, fill, h, lines, run, select, state, text, toast } from './core.js';
import { render } from './main.js';
import { accountName, acct, isSuper, isAdmin } from './session.js';
import { whatsappConnector } from './whatsapp.js';

/* ------------------------------ Canales ------------------------------ */

const CHANNEL_ICONS = { whatsapp: '🟢', telegram: '✈️', messenger: '💬', instagram: '📸', webchat: '🌐', email: '✉️', zernio: '🔗', playground: '🧪' };

export function channelIcon(type) {
  return h('span', { title: type }, CHANNEL_ICONS[type] || '•');
}

const STATE_LABEL = {
  open: ['green', 'Conectado'],
  connecting: ['orange', 'Esperando escaneo'],
  close: ['red', 'Desconectado'],
  not_found: ['red', 'Instancia no creada'],
  not_configured: ['orange', 'Falta configurar'],
  error: ['red', 'Error'],
  unknown: ['', 'Sin información'],
};

export function connectionHref(c) {
  return c.chatbot_id ? `#/bot/${c.chatbot_id}/conexiones/${c.id}` : `#/agentes/conexion/${c.id}`;
}

export function connectionBadge(c) {
  let label = c.active ? 'Activo' : 'Inactivo';
  let color = c.active ? 'green' : '';
  if (c.active && c.type === 'whatsapp') [color, label] = STATE_LABEL[c.connection_state] || ['', 'Sin información'];
  if (c.active && c.type === 'zernio' && !c.config?.account_id) { color = 'orange'; label = 'Pendiente de conectar'; }
  return h('span', { class: `badge ${color}` }, label);
}

export function channelStatusCell(c) {
  const needsConnection = c.type === 'whatsapp' || c.type === 'zernio';
  const connected = c.type === 'whatsapp' ? c.connection_state === 'open' : !!c.config?.account_id;
  return h('td', {}, connectionBadge(c), needsConnection ? h('a', { href: connectionHref(c), class: 'btn small', style: 'margin-left:8px' }, connected ? 'Administrar' : c.type === 'whatsapp' ? 'Ver QR / reconectar' : 'Conectar cuenta') : null);
}

/** Enlace público que reparte a los clientes nuevos entre varios números de WhatsApp. */
export async function poolsCard(channels) {
  const wa = channels.filter((c) => c.type === 'whatsapp');
  const pools = await api('GET', `/api/wa-pools${acct()}`);
  const n = { name: '', strategy: 'least_busy', message: '', channel_ids: wa.map((c) => c.id) };
  const copy = (v) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(v); toast('Copiado'); } catch { toast('Cópialo a mano', true); } } }, 'Copiar');
  const chName = (id) => wa.find((c) => c.id === id)?.name || '—';
  const picker = (obj) => h('div', { class: 'field' }, h('span', {}, 'Números que reciben clientes'), wa.map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: obj.channel_ids.includes(c.id), onchange: (e) => { obj.channel_ids = e.target.checked ? [...obj.channel_ids, c.id] : obj.channel_ids.filter((x) => x !== c.id); } }), `${c.name}${c.config?.number ? ` (+${c.config.number})` : ' (sin conectar)'}`)));
  return h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, '🔀 Enlace que reparte clientes entre tus números'),
    h('p', { class: 'muted' }, 'Pon este enlace en tu web, redes o anuncios: cada persona que lo abra se va a uno de tus números de WhatsApp conectados (los desconectados se saltan solos) y el chat se abre con tu mensaje listo para enviar.'),
    pools.map((p) => h('div', { class: 'list-item' },
      h('div', { class: 'row between' }, h('strong', {}, p.name, ' ', h('span', { class: `badge ${p.active ? 'green' : ''}` }, p.active ? 'activo' : 'pausado')),
        h('div', { class: 'row' },
          h('button', { class: 'small', onclick: async () => { await run(() => api('PUT', `/api/wa-pools/${p.id}`, { active: !p.active })); render(); } }, p.active ? 'Pausar' : 'Activar'),
          h('button', { class: 'small danger', onclick: async () => { if (confirm('¿Borrar este enlace? Dejará de funcionar donde lo hayas publicado.')) { await run(() => api('DELETE', `/api/wa-pools/${p.id}`), 'Eliminado'); render(); } } }, 'Borrar'))),
      h('div', { class: 'row' }, h('code', { style: 'word-break:break-all' }, p.url), copy(p.url)),
      h('div', { class: 'small muted' }, `${p.strategy === 'round_robin' ? 'Por turnos' : 'Al que menos clientes lleva hoy'} · `, p.channel_ids.map((id) => `${chName(id)}: ${p.hits.find((x) => x.channel_id === id)?.today ?? 0} hoy`).join(' · ')))),
    h('details', { open: !pools.length },
      h('summary', {}, '+ Crear un enlace'),
      h('div', { class: 'grid' },
        field('Nombre', text(n, 'name', { placeholder: 'Anuncios de octubre' })),
        field('Cómo repartir', select(n, 'strategy', [['least_busy', 'Al número que menos clientes lleva hoy'], ['round_robin', 'Por turnos, uno y uno']]))),
      field('Mensaje con el que se abre el chat (opcional)', text(n, 'message', { placeholder: 'Hola, vi su anuncio y quiero información' })),
      picker(n),
      h('button', { class: 'primary', onclick: async () => {
        if (!n.name.trim()) return toast('Ponle un nombre', true);
        if (await run(() => api('POST', '/api/wa-pools', { ...n, account_id: state.accountId || undefined }), 'Enlace creado')) render();
      } }, 'Crear enlace')));
}

export async function viewChannels(root, params) {
  const [channels, bots] = await Promise.all([api('GET', `/api/channels${acct()}`), api('GET', `/api/chatbots${acct()}`)]);
  const types = state.meta.channel_types;
  const n = { type: 'whatsapp', name: '', chatbot_id: params.get('chatbot_id') || '' };
  const botOptions = () => [['', '— Sin chatbot (solo guarda mensajes) —'], ...bots.filter((b) => !isSuper() || !n.account_id || b.account_id === n.account_id).map((b) => [b.id, b.name])];
  const botSelect = h('div');
  const drawBots = () => fill(botSelect, field('Asistente que responde', select(n, 'chatbot_id', botOptions()), 'Puedes elegir el mismo asistente para varios teléfonos.'));
  const createBox = h('div', { class: 'card', hidden: params.get('new') !== '1' });
  const picker = isSuper() ? (() => {
    if (!n.account_id) n.account_id = bots.find((b) => b.id === n.chatbot_id)?.account_id || state.accountId || state.accounts[0]?.id || '';
    return field('Cuenta', select(n, 'account_id', state.accounts.map((a) => [a.id, a.name]), () => { n.chatbot_id = ''; drawBots(); }));
  })() : null;
  drawBots();
  fill(createBox,
    h('h3', { style: 'margin-top:0' }, 'Nuevo canal'),
    h('div', { class: 'grid' },
      field('Plataforma', select(n, 'type', types.map((t) => [t.type, t.label]))),
      field('Nombre', text(n, 'name', { placeholder: 'WhatsApp ventas, Instagram @hotel…' }))),
    picker,
    botSelect,
    h('button', { class: 'primary', onclick: async () => {
      const body = { ...n, name: n.name || types.find((t) => t.type === n.type).label, chatbot_id: n.chatbot_id || null };
      const ch = await run(() => api('POST', '/api/channels', body), 'Canal creado');
      if (ch) location.hash = `#/channel/${ch.id}`;
    } }, 'Crear y configurar'));

  const botName = Object.fromEntries(bots.map((b) => [b.id, b.name]));
  const limit = state.meta.max_whatsapp_profiles;
  const selectedAccount = state.accountId || state.me.account?.id;
  const profileCount = channels.filter((c) => c.type === 'whatsapp' && (!selectedAccount || c.account_id === selectedAccount)).length;
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'WhatsApp y otros canales'), h('button', { class: 'primary', onclick: () => (createBox.hidden = !createBox.hidden) }, '+ Nuevo canal')),
    h('div', { class: 'card' }, h('p', { class: 'muted', style: 'margin:0' },
      'Cada canal es una conexión con una plataforma (un número de WhatsApp, un bot de Telegram, una página de Facebook, una cuenta de Instagram o el chat de un sitio web). ',
      'Conecta hasta cuatro perfiles de WhatsApp por cuenta, cada uno con su propio QR. Asigna un asistente diferente a cada teléfono o comparte el mismo en varios. Las conversaciones de cada perfil se mantienen separadas.')),
    !state.meta.public_https ? h('div', { class: 'card' }, h('span', { class: 'badge orange' }, 'Aviso'), ' ',
      `La URL pública (${state.meta.public_base_url}) no es HTTPS. Telegram, Messenger e Instagram exigen HTTPS: define PUBLIC_BASE_URL con tu dominio.`) : null,
    h('p', { class: 'muted small' }, selectedAccount ? `${profileCount} de ${limit} perfiles de WhatsApp. Los perfiles desconectados también ocupan un lugar.` : `Hasta ${limit} perfiles de WhatsApp por cuenta.`),
    createBox,
    h('div', { class: 'card' },
      channels.length
        ? h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Canal'), h('th', {}, 'Plataforma'), h('th', {}, 'Chatbot'), isSuper() && !state.accountId ? h('th', {}, 'Cuenta') : null, h('th', {}, 'Estado'))),
            h('tbody', {}, channels.map((c) => h('tr', { class: 'click', onclick: () => (location.hash = `#/channel/${c.id}`) },
              h('td', {}, channelIcon(c.type), ' ', h('strong', {}, c.name), c.type === 'whatsapp' && c.config.number ? h('div', { class: 'small muted' }, `+${c.config.number}`) : null),
              h('td', {}, c.label),
              h('td', {}, c.chatbot_id ? botName[c.chatbot_id] || '—' : h('span', { class: 'badge orange' }, 'sin chatbot')),
              isSuper() && !state.accountId ? h('td', { class: 'small' }, accountName(c.account_id)) : null,
              channelStatusCell(c)))))
        : h('p', { class: 'muted' }, 'Aún no hay canales.')),
    // Con 2 o más WhatsApp aparece el enlace que reparte clientes (solo para quien administra una cuenta concreta).
    ...((selectedAccount && channels.filter((c) => c.type === 'whatsapp' && c.account_id === selectedAccount).length >= 2 && isAdmin()) ? [await poolsCard(channels.filter((c) => c.account_id === selectedAccount)).catch(() => null)] : []),
  );
}

/** Campos de configuración de cada plataforma. */
function channelConfigFields(ch, cfg) {
  const secret = (key, label, help) => field(label, h('input', { type: 'password', autocomplete: 'off', value: cfg[key] || '', placeholder: cfg[key] ? '' : 'Pega aquí el valor', oninput: (e) => (cfg[key] = e.target.value) }), help);
  switch (ch.type) {
    case 'whatsapp':
      if (!isSuper()) {
        return [field('Número de WhatsApp', text(cfg, 'number', { placeholder: 'Se llena solo al conectar' }), 'Se guarda automáticamente con el número que vincules.')];
      }
      return [
        field('Instancia de Evolution', text(cfg, 'instance', { placeholder: 'Se genera sola' }), 'Nombre único (letras, números, guion y guion bajo). Se genera al crear el canal y se crea en Evolution al conectar.'),
        field('Número de WhatsApp', text(cfg, 'number', { placeholder: '5215512345678' }), 'Con lada de país; opcional, como referencia.'),
        h('details', {}, h('summary', {}, 'Servidor de Evolution distinto al global (solo superadmin)'),
          h('div', { style: 'margin-top:10px' },
            field('URL de Evolution', text(cfg, 'url', { placeholder: 'Vacío = usar EVOLUTION_URL' })),
            secret('api_key', 'API key de Evolution', 'Obligatoria si usas otra URL: la llave global nunca se envía a otro servidor.'))),
      ];
    case 'telegram':
      return [
        secret('bot_token', 'Token del bot', 'Créalo con @BotFather en Telegram (/newbot) y pega el token.'),
        cfg.bot_username ? h('p', {}, 'Bot: ', h('a', { href: `https://t.me/${cfg.bot_username}`, target: '_blank', rel: 'noopener' }, `@${cfg.bot_username}`)) : null,
      ];
    case 'messenger':
      return [
        field('ID de la página de Facebook', text(cfg, 'page_id', { placeholder: '1234567890' }), 'Se completa solo al conectar si lo dejas vacío.'),
        secret('page_access_token', 'Token de acceso de la página', 'Meta for Developers → tu app → Messenger → Tokens de acceso.'),
        secret('app_secret', 'Clave secreta de la app', 'Configuración de la app → Básica. Se usa para verificar que los mensajes vienen de Meta.'),
      ];
    case 'instagram':
      return [
        field('ID de la cuenta de Instagram', text(cfg, 'account_id', { placeholder: '17841400000000000' }), 'Se completa solo al conectar si lo dejas vacío.'),
        secret('page_access_token', 'Token de acceso', 'Token de la página de Facebook vinculada a la cuenta profesional de Instagram.'),
        secret('app_secret', 'Clave secreta de la app', 'Configuración de la app → Básica.'),
      ];
    case 'email': {
      const num = (key, label, help) => field(label, h('input', { type: 'number', value: cfg[key] ?? '', oninput: (e) => (cfg[key] = Number(e.target.value) || 0) }), help);
      const preset = (p) => {
        cfg.provider = p;
        if (p === 'gmail') Object.assign(cfg, { imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 587 });
        if (p === 'outlook') Object.assign(cfg, { imap_host: 'outlook.office365.com', imap_port: 993, smtp_host: 'smtp.office365.com', smtp_port: 587 });
        render();
      };
      return [
        field('Proveedor', h('select', { onchange: (e) => preset(e.target.value) }, [['gmail', 'Gmail / Google Workspace'], ['outlook', 'Outlook / Microsoft 365'], ['otro', 'Otro (IMAP y SMTP)']].map(([v, l]) => h('option', { value: v, selected: cfg.provider === v }, l))), 'Elige uno para rellenar los servidores.'),
        field('Correo (usuario)', text(cfg, 'imap_user', { placeholder: 'atencion@tuempresa.com' })),
        secret('imap_password', 'Contraseña de aplicación', 'En Gmail y Microsoft crea una "contraseña de aplicación" (necesitas la verificación en dos pasos); no uses tu contraseña normal.'),
        field('Nombre al responder', text(cfg, 'from_name', { placeholder: 'Atención Mi Empresa' })),
        h('details', {}, h('summary', {}, 'Servidores'),
          h('div', { class: 'grid', style: 'margin-top:10px' },
            field('Servidor IMAP (recibir)', text(cfg, 'imap_host')), num('imap_port', 'Puerto IMAP'),
            field('Servidor SMTP (enviar)', text(cfg, 'smtp_host')), num('smtp_port', 'Puerto SMTP', '465 usa SSL; 587 usa STARTTLS.'),
            field('Usuario SMTP', text(cfg, 'smtp_user'), 'Vacío = el mismo correo.'), secret('smtp_password', 'Contraseña SMTP', 'Vacía = la misma.'),
            field('Dirección de envío', text(cfg, 'from_address'), 'Vacía = el mismo correo.'))),
      ];
    }
    case 'zernio':
      return [
        field('Red a conectar', text(cfg, 'platform', { placeholder: 'bluesky, reddit, twitter…' }), 'Nombre de la red tal como lo usa Zernio. Para WhatsApp oficial escribe whatsapp. El WhatsApp por QR sigue siendo su propio canal.'),
        field('ID del perfil en Zernio', text(cfg, 'profile_id', { placeholder: 'profile_…' }), 'Perfil de Zernio donde quedará la cuenta conectada.'),
        secret('api_key', 'API key de Zernio', 'Se guarda solo en el servidor; el navegador nunca la recibe completa.'),
        h('p', { class: 'small muted' }, 'Cuenta: ', cfg.account_id ? h('code', {}, cfg.account_id) : 'sin conectar', cfg.username ? ` · @${cfg.username}` : ''),
      ];
    case 'webchat':
      return [
        h('div', { class: 'grid' },
          field('Título', text(cfg, 'title')),
          field('Subtítulo', text(cfg, 'subtitle')),
          field('Color', h('input', { type: 'color', value: cfg.color, oninput: (e) => (cfg.color = e.target.value) })),
          field('Texto del botón', text(cfg, 'launcher_text'))),
        field('Mensaje de bienvenida', area(cfg, 'welcome_message')),
        field('Dominios permitidos', lines(cfg, 'allowed_origins', { placeholder: 'hotelpalmas.mx\n*.hotelpalmas.mx' }), 'Vacío = cualquier sitio puede insertar el chat.'),
      ];
    default:
      return [];
  }
}

export async function viewChannel(root, id, parentId = null) {
  const [ch, bots] = await Promise.all([api('GET', `/api/channels/${id}`), api('GET', '/api/chatbots')]);
  if (parentId && parentId !== ch.chatbot_id) { location.replace(connectionHref(ch)); return; }
  const parent = bots.find((b) => b.id === ch.chatbot_id);
  const back = parent ? `#/bot/${parent.id}/conexiones` : '#/agentes?connections=1';
  const m = { name: ch.name, active: ch.active, chatbot_id: ch.chatbot_id || '' };
  const cfg = clone(ch.config);
  const accountBots = bots.filter((b) => b.account_id === ch.account_id);
  const status = h('span', { class: 'badge' }, 'consultando…');
  const result = h('div');
  const refresh = async () => {
    try {
      const s = await api('GET', `/api/channels/${id}/status`);
      const [cls, label] = STATE_LABEL[s.state] || ['', s.state];
      status.textContent = label + (s.details?.error ? `: ${s.details.error}` : s.details?.last_error ? `: ${s.details.last_error}` : '');
      status.className = `badge ${cls}`;
    } catch (e) {
      status.textContent = e.message;
      status.className = 'badge red';
    }
  };
  const save = async () => {
    const updated = await run(() => api('PUT', `/api/channels/${id}`, { ...m, chatbot_id: m.chatbot_id || null, config: cfg }), 'Guardado ✅');
    if (updated) { const target = connectionHref(updated); if (location.hash !== target) location.hash = target; else render(); }
  };
  const setup = async () => {
    const r = await run(() => api('POST', `/api/channels/${id}/setup`));
    if (!r) return;
    fill(result, h('p', {}, h('span', { class: `badge ${r.ok ? 'green' : 'orange'}` }, r.ok ? 'Listo' : 'Atención'), ' ', r.message));
    refresh();
  };
  const copyBtn = (value) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(value); toast('Copiado'); } catch { toast('No se pudo copiar', true); } } }, 'Copiar');
  const connectZernio = () => run(async () => {
    const r = await api('POST', `/api/channels/${id}/zernio/connect`);
    location.href = r.authUrl;
  }, 'Abriendo Zernio…');

  const connection = [];
  if (ch.type === 'whatsapp') {
    const test = { number: state.me.user.phone || '', text: 'Mensaje de prueba ✅' };
    const box = h('div');
    const setStatus = (s) => { const [cls, label] = STATE_LABEL[s] || ['', s]; status.textContent = label; status.className = `badge ${cls}`; };
    const showConnector = () => fill(box, whatsappConnector(id, { onState: setStatus, onConnected: () => setTimeout(() => render(), 2500) }));
    if (ch.connection_state === 'open') {
      fill(box,
        h('p', {}, h('span', { class: 'badge green' }, '✓ Conectado'), ' ',
          ch.config.profile_name ? h('strong', {}, ch.config.profile_name) : null, ch.config.number ? ` · +${ch.config.number}` : ''),
        h('div', { class: 'row' },
          h('button', { onclick: async () => { if (confirm('¿Vincular otro número? Se desconecta el actual.')) { await run(() => api('POST', `/api/channels/${id}/whatsapp/logout`)); showConnector(); } } }, 'Cambiar de número'),
          h('button', { class: 'danger', onclick: async () => { if (confirm('¿Desconectar este WhatsApp? El asistente dejará de responder por aquí.')) { await run(() => api('POST', `/api/channels/${id}/whatsapp/logout`), 'Desconectado'); render(); } } }, 'Desconectar')));
    } else {
      showConnector();
    }
    connection.push(
      box,
      h('details', { style: 'margin-top:12px' }, h('summary', {}, 'Enviar un mensaje de prueba'),
        h('div', { class: 'grid', style: 'margin-top:10px' }, field('Número (con lada)', text(test, 'number', { placeholder: '5215512345678' })), field('Texto', text(test, 'text'))),
        h('button', { onclick: () => run(() => api('POST', `/api/channels/${id}/whatsapp/test`, test), 'Enviado') }, 'Enviar')),
      h('details', {}, h('summary', {}, 'Opciones avanzadas'),
        h('p', { class: 'small muted' }, 'Si los mensajes no llegan aunque esté conectado, vuelve a registrar el webhook.'),
        h('button', { class: 'small', onclick: setup }, 'Reconfigurar webhook')),
    );
  } else if (ch.type === 'telegram') {
    connection.push(
      h('p', { class: 'muted small' }, 'Al conectar se valida el token y se registra el webhook en Telegram automáticamente.'),
      h('button', { class: 'primary', onclick: setup, disabled: !ch.config.bot_token }, 'Conectar con Telegram'),
    );
  } else if (ch.type === 'zernio') {
    connection.push(
      h('ol', { class: 'small' },
        h('li', {}, 'Guarda la API key, la red y el perfil de Zernio en Configuración.'),
        h('li', {}, 'Conecta la cuenta: se abre Zernio para autorizarla y al terminar regresas a este canal.'),
        h('li', {}, 'Registra el webhook para recibir mensajes en ', h('code', {}, ch.webhook_url), ' ', copyBtn(ch.webhook_url), '.')),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: connectZernio, disabled: !ch.config.api_key || !ch.config.platform || !ch.config.profile_id }, ch.config.account_id ? 'Reconectar cuenta' : 'Conectar cuenta'),
        h('button', { onclick: setup, disabled: !ch.config.api_key || !ch.config.webhook_secret }, 'Registrar webhook')),
    );
  } else if (ch.type === 'messenger' || ch.type === 'instagram') {
    connection.push(
      h('ol', { class: 'small' },
        h('li', {}, 'En Meta for Developers, abre tu app → ', ch.type === 'messenger' ? 'Messenger' : 'Instagram', ' → Webhooks.'),
        h('li', {}, 'URL de devolución de llamada: ', h('code', {}, ch.webhook_url), ' ', copyBtn(ch.webhook_url)),
        h('li', {}, 'Token de verificación: ', h('code', {}, ch.config.verify_token), ' ', copyBtn(ch.config.verify_token)),
        h('li', {}, 'Suscríbete a los campos ', h('code', {}, 'messages'), ', ', h('code', {}, 'messaging_postbacks'), ' y ', h('code', {}, 'message_echoes'), '.'),
        h('li', {}, 'Guarda aquí el token y la clave secreta, y pulsa el botón:')),
      h('button', { class: 'primary', onclick: setup, disabled: !ch.config.page_access_token }, ch.type === 'messenger' ? 'Verificar y suscribir la página' : 'Verificar token'),
    );
  } else if (ch.type === 'email') {
    connection.push(
      h('p', { class: 'muted small' }, 'Al conectar se prueba el acceso de lectura y de envío. Solo se contestan los correos que lleguen después de conectar; avisos automáticos y listas de correo se ignoran. Se revisa el buzón cada minuto.'),
      h('button', { class: 'primary', onclick: setup, disabled: !ch.config.imap_password }, 'Probar y conectar el correo'),
    );
  } else if (ch.type === 'webchat') {
    connection.push(
      h('p', {}, 'Pega este código antes de ', h('code', {}, '</body>'), ' en el sitio web:'),
      h('pre', { class: 'small pre', style: 'background:var(--bg);padding:10px;border-radius:8px' }, ch.embed_code),
      h('div', { class: 'row' }, copyBtn(ch.embed_code), h('a', { class: 'btn', href: `/webchat-demo.html?channel=${encodeURIComponent(ch.webhook_token)}`, target: '_blank', rel: 'noopener' }, 'Vista previa')),
    );
  }

  root.append(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Ubicación' }, h('a', { href: '#/agentes' }, 'Agentes'), ' / ', h('a', { href: back }, parent?.name || 'Conexiones pendientes de asignar'), ' / ', h('span', {}, ch.name)),
    h('div', { class: 'row between' },
      h('h1', {}, channelIcon(ch.type), ' ', ch.name, ' ', h('span', { class: `badge ${ch.active ? 'green' : ''}` }, ch.active ? 'Activo' : 'Inactivo')),
      h('a', { href: `#/conversations?channel_id=${ch.id}` }, 'Ver conversaciones →')),
    h('p', { class: 'muted' }, ch.label, isSuper() ? ` · ${accountName(ch.account_id)}` : ''),
    ch.type === 'whatsapp' ? h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Conexión'), h('span', {}, 'Estado: ', status)), connection, result) : '',
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'General'),
      field('Nombre', text(m, 'name')),
      field('Agente que responde', select(m, 'chatbot_id', [['', '— Sin asistente (solo guarda mensajes) —'], ...accountBots.map((b) => [b.id, b.name])]), 'Un agente puede atender varios teléfonos. Cambiar la asignación conserva los contactos y las conversaciones de esta conexión.'),
      check(m, 'active', 'Activo (si se desactiva, los mensajes se guardan pero no se responden)')),
    ch.type === 'whatsapp'
      ? h('details', { class: 'card' }, h('summary', {}, 'Configuración avanzada de WhatsApp'), h('div', { style: 'margin-top:12px' }, channelConfigFields(ch, cfg)))
      : h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Configuración'), channelConfigFields(ch, cfg)),
    ch.type === 'whatsapp' ? '' : h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Conexión'), h('span', {}, 'Estado: ', status)),
      ch.type !== 'webchat' ? h('p', { class: 'muted small' }, 'Guarda los cambios de configuración antes de conectar.') : null,
      connection,
      result,
      ch.type !== 'webchat' ? h('details', { style: 'margin-top:12px' }, h('summary', {}, 'URL del webhook'),
        h('p', {}, h('code', {}, ch.webhook_url), ' ', copyBtn(ch.webhook_url)),
        h('button', { class: 'small', onclick: async () => { if (confirm('¿Generar una nueva URL? La anterior dejará de funcionar y tendrás que volver a conectar.')) { await run(() => api('POST', `/api/channels/${id}/rotate-token`), 'Nueva URL generada'); render(); } } }, 'Regenerar URL secreta')) : null),
    saveBar(save, h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => {
        if (prompt(`Escribe "${ch.name}" para eliminar el canal y todas sus conversaciones`) === ch.name) {
          await run(() => api('DELETE', `/api/channels/${id}`), 'Canal eliminado');
          location.hash = back;
        }
      } }, 'Eliminar canal'))),
  );
  if (ch.type !== 'whatsapp' || ch.connection_state === 'open') refresh();
  else status.textContent = 'preparando…';
}
