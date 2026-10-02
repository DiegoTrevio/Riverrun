// Panel de administración — JavaScript sin dependencias ni build.

const $app = document.getElementById('app');
const state = { meta: null, me: null, accounts: [], bots: [], timers: [], accountId: '' };
try { state.accountId = localStorage.getItem('cp-account') || ''; } catch { /* sin storage */ }

/* ------------------------------ Utilidades ------------------------------ */

async function api(method, url, body, isForm = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* vacío */ }
  if (res.status === 401 && !url.endsWith('/login')) { location.hash = '#/login'; throw new Error('Sesión expirada'); }
  if (!res.ok) {
    const msg = data?.issues ? `${data.error}: ${data.issues.join('; ')}` : data?.error || `Error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Reemplaza los hijos de un elemento ignorando null/false (igual que h()). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))));
}

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 2500);
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message || String(e), true);
    return undefined;
  }
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '');
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------ Campos de formulario ------------------------------ */

function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', {}, label), input, help ? h('small', {}, help) : null);
}
function text(obj, key, opts = {}) {
  return h('input', { type: opts.type || 'text', value: obj[key] ?? '', placeholder: opts.placeholder, oninput: (e) => (obj[key] = e.target.value) });
}
function area(obj, key, opts = {}) {
  return h('textarea', { class: opts.big ? 'big' : '', placeholder: opts.placeholder, value: obj[key] ?? '', oninput: (e) => (obj[key] = e.target.value) });
}
function num(obj, key, opts = {}) {
  return h('input', {
    type: 'number', step: opts.step ?? 1, min: opts.min, max: opts.max, value: obj[key] ?? '',
    placeholder: opts.placeholder,
    oninput: (e) => (obj[key] = e.target.value === '' ? (opts.nullable ? null : 0) : Number(e.target.value)),
  });
}
function select(obj, key, options, onchange) {
  return h('select', { onchange: (e) => { obj[key] = e.target.value; onchange?.(e.target.value); } },
    options.map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l)));
}
function check(obj, key, label) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => (obj[key] = e.target.checked) }), label);
}
/** Lista de textos, uno por renglón. */
function lines(obj, key, opts = {}) {
  return h('textarea', {
    class: opts.big ? 'big' : '',
    placeholder: opts.placeholder || 'Uno por renglón',
    value: (obj[key] || []).join('\n'),
    oninput: (e) => (obj[key] = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)),
  });
}

/* ------------------------------ Router ------------------------------ */

window.addEventListener('hashchange', render);
render();

function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

const ROLE_LABEL = { superadmin: 'Superadministrador', admin: 'Administrador', agent: 'Agente' };
const isAdmin = () => state.me && state.me.user.role !== 'agent';
const isSuper = () => state.me && state.me.user.role === 'superadmin';
/** Filtro de cuenta para listados (el superadmin puede elegir una o ver todas). */
const acct = (prefix = '?') => (isSuper() && state.accountId ? `${prefix}account_id=${state.accountId}` : '');
const accountName = (id) => state.accounts.find((a) => a.id === id)?.name || '';

async function loadSession() {
  const [meta, me, accounts] = await Promise.all([api('GET', '/api/meta'), api('GET', '/api/me'), api('GET', '/api/accounts')]);
  state.meta = meta;
  state.me = me;
  state.accounts = accounts;
  if (state.accountId && !accounts.some((a) => a.id === state.accountId)) state.accountId = '';
}

async function render() {
  clearTimers();
  const hash = location.hash.slice(1) || '/';
  const [pathPart, qs] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(qs || '');

  if (parts[0] === 'login') return renderLogin();
  if (parts[0] === 'registro') return renderSignup();
  if (parts[0] === 'olvide') return renderForgot();
  if (parts[0] === 'restablecer') return renderReset(params.get('token') || '');
  if (parts[0] === 'verificar') return renderVerify(params.get('token') || '');
  if (!state.me) {
    try {
      await loadSession();
    } catch {
      return;
    }
  }
  // Los agentes solo atienden conversaciones.
  if (!isAdmin() && !['conversations', 'conversation', 'password', 'agenda', 'notifications'].includes(parts[0])) {
    location.hash = '#/conversations';
    return;
  }
  const content = h('div');
  fill($app, shell(parts[0] || 'home', content));
  try {
    if (!parts.length && needsOnboarding()) location.hash = '#/inicio';
    else if (!parts.length) await viewDashboard(content);
    else if (parts[0] === 'inicio') await viewOnboarding(content, parts[1]);
    else if (parts[0] === 'consumo') await viewUsage(content, params);
    else if (parts[0] === 'bot') await viewBot(content, parts[1], parts[2] || 'general');
    else if (parts[0] === 'channels') await viewChannels(content, params);
    else if (parts[0] === 'channel') await viewChannel(content, parts[1]);
    else if (parts[0] === 'conversations') await viewConversations(content, params);
    else if (parts[0] === 'conversation') await viewConversation(content, parts[1]);
    else if (parts[0] === 'users') await viewUsers(content);
    else if (parts[0] === 'accounts') await viewAccounts(content);
    else if (parts[0] === 'logs') await viewLogs(content, params);
    else if (parts[0] === 'password') await viewPassword(content);
    else if (parts[0] === 'automation') await viewAutomation(content, parts[1] || 'rules', parts[2]);
    else if (parts[0] === 'agenda') await viewAgenda(content, parts[1] || 'citas', params);
    else if (parts[0] === 'notifications') await viewNotifications(content);
    else content.append(h('p', {}, 'Página no encontrada'));
  } catch (e) {
    content.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, e.message)));
  }
}

const bell = h('span', { class: 'badge red', hidden: true });
async function refreshBell() {
  try {
    const n = await api('GET', '/api/notifications?limit=1');
    bell.textContent = n.unread;
    bell.hidden = !n.unread;
  } catch { /* sin sesión */ }
}
setInterval(() => { if (state.me) refreshBell(); }, 20000);

function shell(active, content) {
  refreshBell();
  const link = (href, label, key) => h('a', { href, class: active === key ? 'active' : '' }, label);
  const { user, account } = state.me;
  const switcher = isSuper()
    ? h('div', { class: 'account-switch' },
        h('label', { class: 'small muted' }, 'Cuenta'),
        h('select', {
          onchange: (e) => {
            state.accountId = e.target.value;
            try { localStorage.setItem('cp-account', state.accountId); } catch { /* */ }
            render();
          },
        },
        h('option', { value: '' }, 'Todas las cuentas'),
        state.accounts.map((a) => h('option', { value: a.id, selected: a.id === state.accountId }, a.name + (a.active ? '' : ' (inactiva)')))))
    : h('div', { class: 'account-switch small muted' }, account?.name);
  return h('div', { class: 'layout' },
    h('nav', { class: 'sidebar' },
      h('div', { class: 'brand' }, '💬 Chatbots'),
      switcher,
      isAdmin() && (!isSuper() || state.accountId) ? link('#/inicio', 'Primeros pasos', 'inicio') : null,
      isAdmin() ? link('#/', 'Asistentes', 'home') : null,
      isAdmin() ? link('#/channels', 'Canales', 'channels') : null,
      link('#/conversations', 'Conversaciones', 'conversations'),
      link('#/agenda', 'Agenda', 'agenda'),
      isAdmin() ? link('#/automation', 'Automatización', 'automation') : null,
      h('a', { href: '#/notifications', class: active === 'notifications' ? 'active' : '' }, 'Notificaciones ', bell),
      isAdmin() ? link('#/users', 'Usuarios', 'users') : null,
      isSuper() ? link('#/accounts', 'Cuentas', 'accounts') : null,
      isAdmin() ? link('#/consumo', 'Consumo de IA', 'consumo') : null,
      isAdmin() ? link('#/logs', 'Registros', 'logs') : null,
      h('div', { class: 'spacer' }),
      h('div', { class: 'small muted', style: 'padding:4px 10px' }, user.name || user.email, h('br'), ROLE_LABEL[user.role]),
      link('#/password', 'Mi perfil', 'password'),
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/api/logout'); state.me = null; location.hash = '#/login'; } }, 'Cerrar sesión'),
    ),
    h('main', { class: 'main' }, accountBanner(), content),
  );
}

/** Aviso de la cuenta: días de prueba, cuenta en pausa o correo sin confirmar. */
function accountBanner() {
  const { user, account } = state.me;
  if (!account) return null;
  const items = [];
  if (account.status === 'paused') {
    items.push(h('div', { class: 'banner danger' }, h('strong', {}, 'Tu cuenta está en pausa. '),
      'Tu asistente no está respondiendo ni enviando mensajes; tu configuración y tus conversaciones se conservan.',
      state.meta.support_contact ? [' Para activarla escribe a ', h('strong', {}, state.meta.support_contact), '.'] : ''));
  } else if (account.status === 'trial' && account.trial_ends_at) {
    const days = Math.max(0, Math.ceil((new Date(account.trial_ends_at) - Date.now()) / 86400000));
    items.push(h('div', { class: `banner ${days <= 3 ? 'warn' : ''}` },
      `Periodo de prueba: ${days === 0 ? 'termina hoy' : days === 1 ? 'queda 1 día' : `quedan ${days} días`}.`,
      state.meta.support_contact ? [' Para contratar escribe a ', h('strong', {}, state.meta.support_contact), '.'] : ''));
  }
  if (!user.email_verified_at && state.meta.require_email) {
    items.push(h('div', { class: 'banner warn' },
      `Confirma tu correo (${user.email}) con el enlace que te enviamos para poder conectar tu WhatsApp. `,
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace'); } }, 'Reenviar correo')));
  }
  return items.length ? h('div', { class: 'stack', style: 'margin-bottom:16px' }, items) : null;
}

/** Cuenta propia con el asistente sin terminar: se abre "Primeros pasos" en lugar de la lista de chatbots. */
function needsOnboarding() {
  const acc = state.me?.account;
  return !isSuper() && isAdmin() && acc && acc.signup_source === 'signup' && !acc.onboarding?.done;
}

function renderLogin() {
  const f = { email: '', password: '' };
  const signupLink = h('p', { class: 'small', style: 'margin-bottom:0' });
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() => api('POST', '/api/login', f));
    if (ok) { state.me = null; location.hash = '#/'; }
  };
  fill($app,
    h('form', { class: 'card login', onsubmit: submit },
      h('h1', {}, 'Panel de Chatbots'),
      field('Correo', text(f, 'email', { placeholder: 'tu@correo.com' })),
      field('Contraseña', text(f, 'password', { type: 'password' })),
      h('button', { class: 'primary', type: 'submit' }, 'Entrar'),
      h('p', { class: 'small', style: 'margin-bottom:0' }, h('a', { href: '#/olvide' }, '¿Olvidaste tu contraseña?')),
      signupLink,
    ),
  );
  api('GET', '/api/signup/info').then((i) => { if (i.enabled) fill(signupLink, '¿Aún no tienes cuenta? ', h('a', { href: '#/registro' }, `Crea una gratis (${i.trial_days} días de prueba)`)); }).catch(() => undefined);
}

/* ------------------------------ Registro y recuperación (públicas) ------------------------------ */

function publicCard(title, ...kids) {
  fill($app, h('div', { class: 'card login', style: 'max-width:440px' }, h('h1', {}, title), kids));
}

async function renderSignup() {
  let info;
  try { info = await api('GET', '/api/signup/info'); } catch { info = { enabled: false, business_types: [] }; }
  if (!info.enabled) return publicCard('Registro cerrado', h('p', {}, 'Por ahora el registro no está disponible.'), h('a', { href: '#/login' }, 'Iniciar sesión'));
  const f = { name: '', company: '', business_type: 'otro', email: '', password: '', phone: '', accept_terms: false, website: '' };
  const submit = async (e) => {
    e.preventDefault();
    if (!f.accept_terms) return toast('Acepta los términos para continuar', true);
    const r = await run(() => api('POST', '/api/signup', f));
    if (r) { state.me = null; location.hash = '#/inicio'; }
  };
  publicCard('Crea tu asistente',
    h('p', { class: 'muted', style: 'margin-top:0' }, `Prueba gratis ${info.trial_days} días. En unos minutos tu asistente responde por WhatsApp.`),
    h('form', { class: 'stack', onsubmit: submit },
      field('Tu nombre', text(f, 'name')),
      field('Nombre de tu negocio', text(f, 'company', { placeholder: 'Clínica Sonrisa' })),
      field('Tipo de negocio', select(f, 'business_type', info.business_types.map((b) => [b.key, b.label]))),
      field('Correo', text(f, 'email', { type: 'email', placeholder: 'tu@negocio.com' }), 'Te enviaremos un enlace para confirmarlo.'),
      field('Contraseña', text(f, 'password', { type: 'password' }), 'Mínimo 8 caracteres.'),
      field('WhatsApp para avisos (opcional)', text(f, 'phone', { placeholder: '5215512345678' }), 'Ahí te avisamos cuando un cliente pida hablar con una persona.'),
      // Campo trampa para bots: oculto para las personas.
      h('div', { style: 'position:absolute;left:-9999px', 'aria-hidden': 'true' }, h('input', { tabindex: '-1', autocomplete: 'off', oninput: (e) => (f.website = e.target.value) })),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', onchange: (e) => (f.accept_terms = e.target.checked) }),
        'Acepto los términos del servicio. Entiendo que WhatsApp se conecta como "dispositivo vinculado" (no es la API oficial) y que los envíos masivos pueden provocar el bloqueo del número.'),
      h('button', { class: 'primary', type: 'submit' }, 'Crear mi cuenta'),
      h('p', { class: 'small', style: 'margin:0' }, '¿Ya tienes cuenta? ', h('a', { href: '#/login' }, 'Inicia sesión'))));
}

function renderForgot() {
  const f = { email: '' };
  const box = h('div');
  publicCard('Recuperar contraseña', box);
  fill(box, h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const r = await run(() => api('POST', '/api/forgot-password', f));
    if (r) fill(box, h('p', {}, 'Si el correo está registrado, te enviamos un enlace para elegir una contraseña nueva. Vence en 1 hora.'), h('a', { href: '#/login' }, 'Volver a iniciar sesión'));
  } },
    field('Correo', text(f, 'email', { type: 'email' })),
    h('button', { class: 'primary', type: 'submit' }, 'Enviar enlace'),
    h('a', { class: 'small', href: '#/login' }, 'Volver')));
}

function renderReset(token) {
  const f = { token, password: '', confirm: '' };
  const box = h('div');
  publicCard('Nueva contraseña', box);
  if (!token) return fill(box, h('p', {}, 'El enlace no es válido.'), h('a', { href: '#/olvide' }, 'Pedir uno nuevo'));
  fill(box, h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return toast('Las contraseñas no coinciden', true);
    const r = await run(() => api('POST', '/api/reset-password', { token: f.token, password: f.password }));
    if (r) fill(box, h('p', {}, '✅ Listo, ya puedes entrar con tu contraseña nueva.'), h('a', { class: 'btn primary', href: '#/login' }, 'Iniciar sesión'));
  } },
    field('Contraseña nueva', text(f, 'password', { type: 'password' }), 'Mínimo 8 caracteres.'),
    field('Repítela', text(f, 'confirm', { type: 'password' })),
    h('button', { class: 'primary', type: 'submit' }, 'Guardar')));
}

async function renderVerify(token) {
  const box = h('p', {}, 'Confirmando…');
  publicCard('Confirmar correo', box);
  try {
    await api('POST', '/api/verify-email', { token });
    state.me = null;
    fill(box, '✅ Tu correo quedó confirmado. ', h('a', { href: '#/inicio' }, 'Continuar con la configuración →'));
  } catch (e) {
    fill(box, e.message, ' ', h('a', { href: '#/inicio' }, 'Ir al panel'));
  }
}

/** Selector de cuenta al crear algo (solo superadmin; los demás usan la suya). */
function accountPicker(obj) {
  if (!isSuper()) return null;
  if (!obj.account_id) obj.account_id = state.accountId || state.accounts[0]?.id || '';
  return field('Cuenta', select(obj, 'account_id', state.accounts.map((a) => [a.id, a.name])));
}

/* ------------------------------ Dashboard ------------------------------ */

async function viewDashboard(root) {
  const [bots, stats, channels] = await Promise.all([api('GET', `/api/chatbots${acct()}`), api('GET', `/api/stats${acct()}`), api('GET', `/api/channels${acct()}`)]);
  state.bots = bots;
  const byId = Object.fromEntries(stats.chatbots.map((s) => [s.id, s]));
  const nb = { name: '', template: state.me.account?.business_type || 'otro' };
  const createBox = h('div', { class: 'card', hidden: true },
    h('h3', { style: 'margin-top:0' }, 'Nuevo asistente'),
    h('div', { class: 'grid' },
      field('Nombre del negocio', text(nb, 'name', { placeholder: 'Hotel Las Palmas' })),
      field('Tipo de negocio', select(nb, 'template', (state.meta.business_types || []).map((b) => [b.key, b.label])), 'Nace con la forma de atender, reglas y datos típicos de ese giro. Todo se puede cambiar.')),
    accountPicker(nb),
    h('button', { class: 'primary', onclick: async () => {
      if (!nb.name.trim()) return toast('Escribe un nombre', true);
      const bot = await run(() => api('POST', '/api/chatbots', nb));
      if (bot) location.hash = `#/bot/${bot.id}/conocimiento`;
    } }, 'Crear y agregar su información'));
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

/* ------------------------------ Chatbot ------------------------------ */

// Orden en que se configura un asistente; lo técnico queda en "Avanzado".
const TABS = [
  ['general', 'Resumen'],
  ['conocimiento', 'Lo que sabe'],
  ['personalidad', 'Cómo habla'],
  ['reglas', 'Reglas'],
  ['imagenes', 'Fotos'],
  ['datos', 'Datos que pide'],
  ['probar', 'Probar'],
  ['avanzado', 'Avanzado'],
];
const TAB_ALIASES = { flujo: 'avanzado', ia: 'avanzado' };

/** Marca si el sistema hace cumplir un ajuste o si es una guía para la IA. */
const guaranteed = () => h('span', { class: 'badge green', title: 'El sistema lo revisa antes de enviar cada respuesta: si no se cumple, la corrige o pide otra a la IA.' }, '✓ Garantizado');
const guide = () => h('span', { class: 'badge', title: 'Instrucción para la IA. La sigue casi siempre; compruébalo en Probar.' }, 'Guía');
const tag = (label, badge) => h('span', {}, label, ' ', badge);

async function viewBot(root, id, tab) {
  tab = TAB_ALIASES[tab] || tab;
  const bot = await api('GET', `/api/chatbots/${id}`);
  root.append(
    h('div', { class: 'row between' },
      h('h1', {}, bot.name, ' ', h('span', { class: `badge ${bot.active ? 'green' : ''}` }, bot.active ? 'Encendido' : 'Apagado')),
      h('a', { href: `#/conversations?chatbot_id=${bot.id}` }, 'Ver conversaciones →')),
    h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { href: `#/bot/${id}/${k}`, class: k === tab ? 'active' : '' }, l))),
  );
  const body = h('div');
  root.append(body);
  const views = { general: tabGeneral, personalidad: tabPersonality, conocimiento: tabKnowledge, imagenes: tabImages, reglas: tabRules, datos: tabData, avanzado: tabAdvanced, probar: tabPlayground };
  await (views[tab] || tabGeneral)(body, bot);
}

function saveBar(onSave, extra) {
  return h('div', { class: 'sticky-save row' }, h('button', { class: 'primary', onclick: onSave }, 'Guardar cambios'), extra);
}

async function saveBot(bot, patch) {
  return run(() => api('PUT', `/api/chatbots/${bot.id}`, patch), 'Guardado ✅');
}

async function tabGeneral(root, bot) {
  const m = { name: bot.name, active: bot.active };
  const channels = bot.channels || [];
  const dup = { account_id: bot.account_id };
  const knowledge = await api('GET', `/api/chatbots/${bot.id}/knowledge`).catch(() => []);
  const steps = [
    [knowledge.some((k) => k.active), 'Tiene la información de tu negocio', 'conocimiento', 'Agrega precios, servicios, horarios y preguntas frecuentes: es lo único que puede afirmar.'],
    [!!bot.personality.prompt.trim(), 'Sabe quién es y a quién atiende', 'personalidad', 'Escribe en "Cómo habla" qué hace tu negocio y qué debe lograr el asistente.'],
    [channels.some((c) => c.active), 'Está en al menos un canal', null, 'Conéctalo a WhatsApp u otro canal con "+ Agregar canal".'],
    [bot.active, 'Está encendido', null, 'Marca "Encendido" abajo y guarda.'],
  ];
  const ready = steps.every(([ok]) => ok);
  root.append(
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, ready ? '✅ Tu asistente está listo y respondiendo' : 'Para que tu asistente funcione'),
      h('ul', { class: 'checklist' }, steps.map(([ok, label, tabKey, help]) =>
        h('li', { class: ok ? 'ok' : '' }, h('span', { class: 'mark' }, ok ? '✓' : '○'), ' ',
          tabKey ? h('a', { href: `#/bot/${bot.id}/${tabKey}` }, label) : label,
          ok ? null : h('div', { class: 'small muted' }, help)))),
      h('p', { class: 'small muted', style: 'margin-bottom:0' }, 'Antes de encenderlo, ', h('a', { href: `#/bot/${bot.id}/probar` }, 'pruébalo como si fueras un cliente'), '.')),
    h('div', { class: 'card' },
      field('Nombre del asistente o negocio', text(m, 'name')),
      check(m, 'active', 'Encendido (responde solo a los clientes en sus canales)'),
      isSuper() ? h('p', { class: 'muted small' }, 'Cuenta: ', accountName(bot.account_id)) : null,
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Canales que atiende'),
        h('a', { class: 'btn', href: `#/channels?new=1&chatbot_id=${bot.id}` }, '+ Agregar canal')),
      h('p', { class: 'muted small' }, 'El mismo asistente (información, reglas y fotos) responde igual en todos sus canales.'),
      channels.length
        ? h('table', {}, h('tbody', {}, channels.map((c) => h('tr', { class: 'click', onclick: () => (location.hash = `#/channel/${c.id}`) },
            h('td', {}, channelIcon(c.type), ' ', h('strong', {}, c.name)), h('td', {}, c.label),
            h('td', {}, h('span', { class: `badge ${c.active ? 'green' : ''}` }, c.active ? 'Activo' : 'Inactivo'))))))
        : h('p', {}, 'Aún no tiene canales. Mientras tanto puedes probarlo en la pestaña ', h('a', { href: `#/bot/${bot.id}/probar` }, 'Probar'), '.'),
    ),
    saveBar(async () => { if (await saveBot(bot, m)) render(); },
      h('span', { class: 'row', style: 'margin-left:auto' },
        isSuper() ? h('span', { style: 'min-width:180px' }, select(dup, 'account_id', state.accounts.map((a) => [a.id, a.name]))) : null,
        h('button', { onclick: async () => { const c = await run(() => api('POST', `/api/chatbots/${bot.id}/duplicate`, dup), 'Chatbot duplicado'); if (c) location.hash = `#/bot/${c.id}/general`; } }, isSuper() ? 'Duplicar en esa cuenta' : 'Duplicar'),
        h('button', { class: 'danger', onclick: async () => { if (prompt(`Escribe "${bot.name}" para eliminarlo (sus canales quedarán sin chatbot)`) === bot.name) { await run(() => api('DELETE', `/api/chatbots/${bot.id}`), 'Eliminado'); location.hash = '#/'; } } }, 'Eliminar'))),
  );
}

const TONE_PRESETS = ['natural', 'cercano', 'profesional', 'casual', 'formal', 'mexicano', 'amable', 'breve', 'entusiasta', 'elegante', 'divertido'];

function tabPersonality(root, bot) {
  const p = clone(bot.personality);
  const toneInput = h('input', { type: 'text', value: p.tone.join(', '), oninput: (e) => (p.tone = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) });
  const addTone = (t) => { if (!p.tone.includes(t)) { p.tone.push(t); toneInput.value = p.tone.join(', '); } };
  root.append(
    h('div', { class: 'card' },
      field('Nombre del asistente (opcional)', text(p, 'assistant_name', { placeholder: 'Sofía' }), 'Si lo defines, así se presenta. Déjalo vacío para no presentarse con nombre.'),
      field(tag('Instrucciones para tu asistente', guide()), area(p, 'prompt', { big: true, placeholder: 'Ej.: Trabajas en la recepción del Hotel Las Palmas en Cancún. Ayudas a los huéspedes a resolver dudas y a reservar. Eres cálido y vas al grano. Cuando alguien muestra interés, pregúntale fechas y número de personas.' }),
        'Quién es, a quién atiende y qué debe lograr, como se lo explicarías a un empleado nuevo. Los precios y datos van en "Lo que sabe", no aquí.'),
      h('div', { class: 'grid' },
        field(tag('Trato', guaranteed()), select(p, 'formality', [['tu', 'De tú'], ['usted', 'De usted']]), 'Si la IA mezcla el trato, la respuesta se rehace.'),
        field(tag('Largo de las respuestas', guaranteed()), select(p, 'response_length', [['muy_corta', 'Muy cortas (1-2 frases)'], ['corta', 'Cortas (1-3 frases)'], ['media', 'Medianas (un párrafo)'], ['detallada', 'Detalladas']]), 'Si se pasa de largo, se le pide resumir.'),
        field(tag('Emojis', guaranteed()), select(p, 'emojis', [['none', 'Ninguno'], ['few', 'Pocos (máximo 2)'], ['normal', 'Los que quiera']]), 'Los de más se quitan antes de enviar.'),
      ),
      field(tag('Tono', guide()), toneInput, 'Separado por comas, o elige:'),
      h('div', { class: 'row', style: 'margin:-6px 0 14px' }, TONE_PRESETS.map((t) => h('button', { class: 'small', onclick: () => addTone(t) }, `+ ${t}`))),
      h('details', {}, h('summary', {}, 'Más opciones de estilo'),
        h('div', { style: 'margin-top:10px' },
          field('Idioma', text(p, 'language')),
          field(tag('Ejemplos de cómo escribes', guide()), lines(p, 'style_examples', { placeholder: 'Mensajes reales de cómo escribe el negocio, uno por renglón.\nEj.: ¡Hola! Claro, con gusto te ayudo 😊' }),
            'Opcional. La IA imita el estilo (no copia el texto).'))),
    ),
    saveBar(async () => { if (await saveBot(bot, { personality: p })) render(); }),
  );
}

/** Avance del recorrido en una conversación: etapa actual y si se cumplió el objetivo. */
function flowCard(flow, c) {
  if (!flow || (!flow.goal && !flow.steps?.length)) return null;
  return h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Recorrido'),
    c.goal_completed_at ? h('p', {}, h('span', { class: 'badge green' }, '🎯 Objetivo cumplido'), ' ', h('span', { class: 'small muted' }, fmtDate(c.goal_completed_at))) : flow.goal ? h('p', { class: 'small' }, 'Objetivo: ', flow.goal) : null,
    flow.steps?.length ? h('ol', { class: 'small flow-steps' }, flow.steps.map((st, i) =>
      h('li', { class: i + 1 < (c.flow_step || 0) ? 'done' : i + 1 === c.flow_step ? 'current' : '' }, st.title))) : null);
}

const CAT_LABELS = { general: 'General', servicios: 'Servicios', productos: 'Productos', precios: 'Precios', horarios: 'Horarios', ubicaciones: 'Ubicación y contacto', condiciones: 'Políticas y condiciones', preguntas_frecuentes: 'Preguntas frecuentes', promociones: 'Promociones', otro: 'Otro' };
const catLabel = (c) => CAT_LABELS[c] || c.replace(/_/g, ' ');

async function tabKnowledge(root, bot) {
  const items = await api('GET', `/api/chatbots/${bot.id}/knowledge`);
  const cats = state.meta.knowledge_categories;
  const catOptions = cats.map((c) => [c, catLabel(c)]);
  const newItem = { category: 'general', title: '', content: '', always_include: false };
  const total = items.filter((i) => i.active).reduce((a, i) => a + i.title.length + i.content.length, 0);

  const itemView = (it) => {
    const m = clone(it);
    let editing = false;
    const box = h('div', { class: 'list-item' });
    const draw = () => {
      fill(box, );
      if (!editing) {
        box.append(
          h('div', { class: 'row between' },
            h('div', {},
              h('span', { class: 'badge' }, catLabel(it.category)), ' ',
              h('strong', {}, it.title), ' ',
              !it.active ? h('span', { class: 'badge orange' }, 'inactivo') : null, ' ',
              it.always_include ? h('span', { class: 'badge green' }, 'siempre incluido') : null),
            h('div', { class: 'row' },
              h('button', { class: 'small', onclick: () => { editing = true; draw(); } }, 'Editar'),
              h('button', { class: 'small danger', onclick: async () => { if (confirm('¿Eliminar?')) { await run(() => api('DELETE', `/api/knowledge/${it.id}`), 'Eliminado'); render(); } } }, 'Eliminar'))),
          h('div', { class: 'pre muted', style: 'margin-top:8px' }, it.content),
        );
      } else {
        box.append(
          h('div', { class: 'grid' }, field('Categoría', select(m, 'category', catOptions)), field('Título', text(m, 'title'))),
          field('Contenido', area(m, 'content', { big: true })),
          check(m, 'active', 'Activo'),
          check(m, 'always_include', 'Esencial: tenerlo siempre presente'),
          h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: async () => { if (await run(() => api('PUT', `/api/knowledge/${it.id}`, m), 'Guardado')) render(); } }, 'Guardar'),
            h('button', { onclick: () => { editing = false; draw(); } }, 'Cancelar')),
        );
      }
    };
    draw();
    return box;
  };

  root.append(
    h('div', { class: 'card' },
      h('p', { style: 'margin-top:0' }, guaranteed(), ' ',
        'Todo lo que tu asistente afirma sale de aquí. Antes de enviar cada respuesta, el sistema comprueba que cada precio, cantidad, teléfono, correo o enlace esté escrito en esta información; si no está, la respuesta se rehace o se usa tu mensaje de respaldo.'),
      h('p', { class: 'small muted', style: 'margin-bottom:0' }, 'Escribe datos concretos, uno por renglón: "Limpieza dental: $600". ',
        total > bot.ai.knowledge_char_budget * 0.7
          ? `Tienes mucha información (${total.toLocaleString()} caracteres): en cada respuesta se usa la más relacionada con la pregunta. Marca como "esencial" lo que siempre deba tener presente.`
          : `${items.length} ${items.length === 1 ? 'tema' : 'temas'} cargados.`),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Agregar información'),
      h('div', { class: 'grid' }, field('Categoría', select(newItem, 'category', catOptions)), field('Título', text(newItem, 'title', { placeholder: 'Ej.: Precios de habitaciones' }))),
      field('Contenido', area(newItem, 'content', { big: true, placeholder: 'Habitación sencilla: $1,200 MXN por noche...\nHabitación doble: $1,650 MXN por noche...' })),
      check(newItem, 'always_include', 'Esencial: tenerlo siempre presente (dirección, políticas importantes)'),
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', `/api/chatbots/${bot.id}/knowledge`, newItem), 'Agregado')) render(); } }, 'Agregar'),
    ),
    ...cats.filter((c) => items.some((i) => i.category === c)).map((c) =>
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, catLabel(c)), items.filter((i) => i.category === c).map(itemView))),
    ...(items.some((i) => !cats.includes(i.category)) ? [h('div', { class: 'card' }, h('h3', {}, 'Otras'), items.filter((i) => !cats.includes(i.category)).map(itemView))] : []),
  );
}

async function tabImages(root, bot) {
  const images = await api('GET', `/api/chatbots/${bot.id}/images`);
  const n = { code: '', name: '', description: '', usage_rule: '', caption: '' };
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const upload = async () => {
    if (!fileInput.files[0]) return toast('Selecciona un archivo', true);
    const fd = new FormData();
    for (const [k, v] of Object.entries(n)) fd.append(k, v);
    fd.append('file', fileInput.files[0]);
    if (await run(() => api('POST', `/api/chatbots/${bot.id}/images`, fd, true), 'Imagen agregada')) render();
  };
  const card = (img) => {
    const m = clone(img);
    const replace = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const save = async () => {
      const fd = new FormData();
      for (const k of ['code', 'name', 'description', 'usage_rule', 'caption']) fd.append(k, m[k] ?? '');
      fd.append('active', String(m.active));
      if (replace.files[0]) fd.append('file', replace.files[0]);
      if (await run(() => api('PUT', `/api/images/${img.id}`, fd, true), 'Imagen actualizada')) render();
    };
    return h('div', { class: 'img-card' },
      h('img', { src: `/api/images/${img.id}/file?v=${encodeURIComponent(img.file_path)}`, alt: img.name, loading: 'lazy' }),
      h('div', { class: 'body' },
        h('div', { class: 'row between' }, h('code', {}, img.code), !img.active ? h('span', { class: 'badge orange' }, 'inactiva') : null),
        field('ID (lo usa la IA)', text(m, 'code')),
        field('Nombre', text(m, 'name')),
        field('Qué muestra', area(m, 'description')),
        field('Cuándo enviarla', area(m, 'usage_rule')),
        field('Pie de foto (opcional)', text(m, 'caption')),
        check(m, 'active', 'Activa'),
        field('Reemplazar archivo', replace),
        h('div', { class: 'row' },
          h('button', { class: 'primary small', onclick: save }, 'Guardar'),
          h('button', { class: 'small danger', onclick: async () => { if (confirm('¿Eliminar imagen?')) { await run(() => api('DELETE', `/api/images/${img.id}`), 'Eliminada'); render(); } } }, 'Eliminar'))),
    );
  };
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'La IA solo puede elegir entre estas imágenes por su ID; el backend verifica que existan y estén activas antes de enviarlas. Describe bien qué muestra cada una y cuándo usarla.'),
      h('h3', {}, 'Agregar imagen'),
      h('div', { class: 'grid' },
        field('ID', text(n, 'code', { placeholder: 'habitacion_doble' }), 'Minúsculas, números, - y _'),
        field('Nombre', text(n, 'name', { placeholder: 'Foto habitación doble' })),
        field('Archivo (JPG, PNG o WEBP, máx. 5 MB)', fileInput)),
      field('Qué muestra', area(n, 'description', { placeholder: 'Habitación doble con dos camas matrimoniales y vista al mar' })),
      field('Cuándo enviarla', area(n, 'usage_rule', { placeholder: 'Cuando el cliente pregunte por la habitación doble o pida fotos de las habitaciones' })),
      field('Pie de foto (opcional)', text(n, 'caption')),
      h('button', { class: 'primary', onclick: upload }, 'Subir imagen'),
    ),
    h('div', { class: 'grid' }, images.map(card)),
  );
}

function tabRules(root, bot) {
  const r = clone(bot.rules);
  root.append(
    h('div', { class: 'card legend' },
      h('p', { style: 'margin:0' }, guaranteed(), ' El sistema lo revisa antes de enviar cada respuesta; si no se cumple, la corrige o pide otra a la IA. ',
        guide(), ' Instrucción para la IA: la sigue casi siempre. Compruébalo en ', h('a', { href: `#/bot/${bot.id}/probar` }, 'Probar'), '.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Cuando no tiene un dato'),
      check(r, 'verify_facts', tag('No inventar precios, cantidades, teléfonos, correos ni enlaces (recomendado)', guaranteed())),
      field(tag('Si le preguntan algo que no está en "Lo que sabe"…', guaranteed()), select(r, 'unknown_info_behavior', [['say_unknown', 'Decir que no lo tiene confirmado'], ['ask', 'Hacer una pregunta para entender mejor'], ['handoff', 'Pasar con una persona del equipo']])),
      field(tag('Mensaje de respaldo', guaranteed()), area(r, 'fallback_message'), 'Se envía tal cual si la IA insiste en un dato que no puede comprobarse.'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Pasar con una persona'),
      field(tag('Palabras que pasan con una persona de inmediato', guaranteed()), lines(r, 'handoff_keywords'), 'Si el cliente escribe alguna, se transfiere sin consultar a la IA.'),
      field(tag('Cuándo pasar con una persona', guide()), lines(r, 'handoff_rules'), 'Situaciones, una por renglón: "El cliente quiere pagar", "Tiene una queja".'),
      field(tag('Mensaje al pasar con una persona', guaranteed()), area(r, 'handoff_message'), 'Se envía tal cual. Después el asistente deja de responder en esa conversación hasta que se la devuelvas.'),
      field('WhatsApp que recibe el aviso', text(r, 'handoff_notify_number', { placeholder: '5215512345678' }), 'Opcional, con lada. Además se avisa en el panel y por WhatsApp a quien lo tenga activado en "Mi perfil".'),
      check(r, 'pause_on_human_reply', tag('Si alguien del equipo contesta desde el teléfono, el asistente se calla en esa conversación', guaranteed())),
      field('El asistente retoma la conversación después de (minutos)', num(r, 'auto_resume_minutes', { min: 0 }), '0 = nunca solo; se la devuelves desde Conversaciones.'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Temas y reglas de tu negocio'),
      field(tag('Temas de los que no debe hablar', guaranteed()), lines(r, 'forbidden_topics', { placeholder: 'Política\nCompetencia' }),
        'Si los menciona sin que el cliente pregunte, se quitan de la respuesta. Si el cliente pregunta, declina con amabilidad.'),
      field(tag('Reglas de tu negocio', guide()), lines(r, 'custom_rules', { big: true, placeholder: 'Nunca ofrezcas descuentos\nSiempre pregunta las fechas antes de hablar de disponibilidad\nNo confirmes reservaciones: eso lo hace una persona' }),
        'Una por renglón, concretas. Lo que tenga precio o cifra, escríbelo también en "Lo que sabe": así queda garantizado.'),
      field(tag('De qué puede hablar', guide()), area(r, 'allowed_topics', { placeholder: 'Reservaciones, habitaciones, servicios del hotel, ubicación' }), 'Opcional. Si le preguntan algo ajeno, redirige la conversación.'),
      field(tag('Frases que nunca debe usar', guaranteed()), lines(r, 'banned_phrases'), 'Si aparece alguna, la respuesta se rehace.'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Fotos'),
      field(tag('Cuándo mandar fotos', guide()), area(r, 'image_rules', { placeholder: 'Envía la foto de una habitación cuando el cliente pregunte por ella o quiera verla.' })),
      h('div', { class: 'grid' }, field(tag('Máximo de fotos por respuesta', guaranteed()), num(r, 'max_images_per_reply', { min: 0, max: 5 }))),
      check(r, 'avoid_repeating_images', tag('No reenviar fotos ya enviadas (salvo que el cliente las pida)', guaranteed())),
      h('p', { class: 'small muted' }, guaranteed(), ' Solo se envían fotos de tu catálogo; nunca promete una foto que no existe.'),
    ),
    saveBar(async () => { if (await saveBot(bot, { rules: r })) render(); }),
  );
}

function uniqueKey(label, fields) {
  const base = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'dato';
  let key = base;
  for (let i = 2; fields.some((f) => f.key === key); i++) key = `${base}_${i}`;
  return key;
}

function tabData(root, bot) {
  const fields = clone(bot.data_fields);
  const list = h('div');
  const types = [['text', 'Texto'], ['name', 'Nombre'], ['email', 'Correo'], ['phone', 'Teléfono'], ['date', 'Fecha'], ['number', 'Número'], ['option', 'Opción de lista']];
  const draw = () => {
    fill(list, 
      ...fields.map((f, i) =>
        h('div', { class: 'list-item' },
          h('div', { class: 'grid' },
            field('Dato', text(f, 'label', { placeholder: 'Correo electrónico' })),
            field('Tipo', select(f, 'type', types, draw)),
            field('Cuándo pedirlo', text(f, 'ask_when', { placeholder: 'Cuando quiera cotizar o reservar' }))),
          f.type === 'option' ? field('Respuestas válidas', lines(f, 'options'), 'Una por renglón. Solo se guarda si coincide con alguna.') : null,
          check(f, 'required', 'Importante: procura conseguirlo en la conversación'),
          h('div', { class: 'row' },
            h('button', { class: 'small', disabled: i === 0, onclick: () => { [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; draw(); } }, '↑'),
            h('button', { class: 'small', disabled: i === fields.length - 1, onclick: () => { [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; draw(); } }, '↓'),
            h('button', { class: 'small danger', onclick: () => { fields.splice(i, 1); draw(); } }, 'Quitar')),
        )),
    );
  };
  draw();
  root.append(
    h('div', { class: 'card' },
      h('p', { style: 'margin-top:0' }, 'Datos que tu asistente pide durante la conversación, sin formularios. Los verás en la ficha de cada cliente.'),
      h('p', { class: 'small muted' }, guaranteed(), ' Solo se guarda un dato si tiene el formato correcto (un correo válido, un teléfono, una de las respuestas válidas) y no se vuelve a pedir lo que ya se tiene.'),
      list,
      h('button', { onclick: () => { fields.push({ key: '', label: '', type: 'text', description: '', options: [], required: false, ask_when: '' }); draw(); } }, '+ Agregar dato'),
    ),
    saveBar(async () => {
      if (fields.some((f) => !f.label.trim())) return toast('Escribe el nombre de cada dato', true);
      // La clave interna se genera del nombre (las existentes no cambian: así se conservan los datos guardados).
      for (const f of fields) if (!f.key) f.key = uniqueKey(f.label, fields);
      if (await saveBot(bot, { data_fields: fields })) render();
    }),
  );
}

function tabAdvanced(root, bot) {
  const f = clone(bot.flow);
  const a = clone(bot.ai);
  root.append(
    h('div', { class: 'card legend' }, h('p', { style: 'margin:0' }, 'No necesitas cambiar nada aquí para que tu asistente funcione. Son ajustes finos del recorrido de la conversación y del modelo de IA.')),
    flowSection(f),
    aiSection(a),
    saveBar(async () => { if (await saveBot(bot, { flow: f, ai: a })) render(); }),
  );
}

function flowSection(f) {
  const list = h('div');
  const draw = () => {
    fill(list, 
      ...f.steps.map((s, i) =>
        h('div', { class: 'list-item' },
          h('div', { class: 'row between' }, h('strong', {}, `Etapa ${i + 1}`),
            h('div', { class: 'row' },
              h('button', { class: 'small', disabled: i === 0, onclick: () => { [f.steps[i - 1], f.steps[i]] = [f.steps[i], f.steps[i - 1]]; draw(); } }, '↑'),
              h('button', { class: 'small', disabled: i === f.steps.length - 1, onclick: () => { [f.steps[i + 1], f.steps[i]] = [f.steps[i], f.steps[i + 1]]; draw(); } }, '↓'),
              h('button', { class: 'small danger', onclick: () => { f.steps.splice(i, 1); draw(); } }, 'Quitar'))),
          field('Título', text(s, 'title', { placeholder: 'Entender qué busca' })),
          field('Descripción', area(s, 'description', { placeholder: 'Pregunta fechas y número de personas si no los ha dicho' })),
        )),
    );
  };
  draw();
  return h('div', {},
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Recorrido de la conversación ', guide()),
      h('p', { class: 'muted' }, 'Es una guía, no un guion: el cliente puede saltar pasos o dar todo junto y el asistente se adapta.'),
      field('Objetivo de la conversación', area(f, 'goal', { placeholder: 'Que el cliente haga una reservación o deje sus datos para que un asesor lo contacte.' })),
      field('Saludo sugerido', text(f, 'greeting', { placeholder: '¡Hola! Gracias por escribir al Hotel Las Palmas 🌴' })),
      h('h3', {}, 'Etapas sugeridas'),
      list,
      h('button', { onclick: () => { f.steps.push({ title: '', description: '' }); draw(); } }, '+ Agregar etapa'),
      h('div', { style: 'margin-top:14px' },
        field(tag('Cuando se cumpla el objetivo, el asistente…', guide()), area(f, 'on_goal_completed', { placeholder: 'Agradece y confirma los datos recibidos.' })),
        field(tag('…y además el sistema', guaranteed()), select(f, 'on_goal_action', [['none', 'No hace nada más'], ['handoff', 'Pasa la conversación a una persona'], ['notify', 'Avisa al equipo (panel y WhatsApp)']]),
          'El objetivo solo cuenta como cumplido cuando ya se tienen los datos marcados como "Importante" en "Datos que pide". Pasa una sola vez por conversación; también puedes usarlo como disparador en Automatización.')),
    ));
}

function aiSection(a) {
  return h('div', {},
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Modelo de IA'),
      h('div', { class: 'grid' },
        field('Modelo de OpenAI', text(a, 'model', { placeholder: state.meta.default_model }), `Vacío = ${state.meta.default_model}`),
        field('Temperatura', num(a, 'temperature', { step: 0.1, min: 0, max: 2, nullable: true }), 'Menor = más consistente. Se ignora en modelos de razonamiento.'),
        field('Esfuerzo de razonamiento', select(a, 'reasoning_effort', [['', 'Por defecto'], ['minimal', 'Mínimo'], ['low', 'Bajo'], ['medium', 'Medio'], ['high', 'Alto']]), 'Solo modelos gpt-5 / o-series.')),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Memoria y contexto'),
      h('div', { class: 'grid' },
        field('Mensajes recientes enviados a la IA', num(a, 'recent_messages', { min: 2, max: 60 })),
        field('Resumir cada N mensajes adicionales', num(a, 'summary_batch', { min: 4, max: 100 }), 'Lo más antiguo se resume para no mandar todo el historial.'),
        field('Presupuesto de conocimiento (caracteres)', num(a, 'knowledge_char_budget', { min: 1000, step: 1000 }))),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Comportamiento en el chat'),
      h('div', { class: 'grid' },
        field('Esperar antes de responder (segundos)', num(a, 'debounce_seconds', { min: 0, max: 60, step: 0.5 }), 'Agrupa mensajes seguidos del cliente.'),
        field(tag('Máximo de mensajes por respuesta', guaranteed()), num(a, 'max_bubbles', { min: 1, max: 5 })),
        field(tag('Máximo de caracteres por mensaje', guaranteed()), num(a, 'max_chars_per_bubble', { min: 80, max: 2000 }), 'Los mensajes más largos se dividen.')),
      h('p', { class: 'small muted' }, 'La zona horaria y el horario de atención que conoce el asistente se toman de ', h('a', { href: '#/automation/settings' }, 'Automatización → Horario y ajustes'), '.'),
      check(a, 'typing_simulation', 'Mostrar "escribiendo…" antes de cada mensaje'),
      check(a, 'transcribe_audio', 'Entender notas de voz (las transcribe; tiene un costo pequeño por minuto)'),
    ));
}

const ACTION_LABEL = { reply: 'Respondió', reply_with_image: 'Respondió con foto', handoff: 'Pasó la conversación a una persona', no_reply: 'No respondió', human: 'No respondió: la conversación está con una persona', inactive: 'No respondió: el asistente está apagado', error: 'Error' };

/** Traduce el motivo que se le dio a la IA a lenguaje para el dueño del negocio. */
function explainIssue(x) {
  const rules = [
    [/^Mencionaste datos que no están[^:]*: (.*?)\. Elimina.*$/s, (m) => `Quiso dar un dato que no está en tu información (${m[1]}). Se bloqueó.`],
    [/^No uses estas frases: (.*?)\.$/s, (m) => `Usó una frase prohibida (${m[1]}).`],
    [/^No hables de estos temas: (.*?)\. .*$/s, (m) => `Mencionó un tema prohibido (${m[1]}).`],
    [/^Trata al cliente de "usted".*$/s, () => 'Tuteó al cliente y está configurado "de usted".'],
    [/^Trata al cliente de "tú".*$/s, () => 'Habló de usted y está configurado "de tú".'],
    [/^La respuesta es demasiado larga.*$/s, () => 'La respuesta era más larga de lo configurado.'],
    [/^Un mensaje es demasiado largo.*$/s, () => 'Un mensaje era demasiado largo.'],
    [/^Dices que envías una imagen.*$/s, () => 'Prometió una foto que no está en tu catálogo.'],
    [/^Los IDs de imagen.*$/s, () => 'Quiso enviar una foto que no existe en tu catálogo.'],
    [/^El horario ".*" no está disponible.*$/s, () => 'Ofreció un horario que no está disponible en tu agenda.'],
    [/^El servicio ".*" no existe.*$/s, () => 'Quiso agendar un servicio que no existe.'],
    [/^Para agendar la llamada primero pide.*$/s, () => 'Quiso agendar una llamada sin tener el teléfono del cliente.'],
  ];
  for (const [re, fn] of rules) { const m = x.match(re); if (m) return fn(m); }
  return x;
}

/** Preguntas para comprobar que respeta la información y las reglas. */
const TEST_IDEAS = ['¿Cuánto cuesta?', '¿Qué horario tienen?', '¿Dónde están?', '¿Me haces un descuento?', '¿Tienen servicio a domicilio?', 'Quiero hablar con una persona'];

async function tabPlayground(root, bot) {
  const session = localStorage.getItem('pg-session') || Math.random().toString(36).slice(2, 10);
  try { localStorage.setItem('pg-session', session); } catch { /* sin storage */ }
  const chat = h('div', { class: 'chat' });
  const debug = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Después de cada respuesta verás qué hizo el asistente, si alguna regla obligó a corregirla y qué datos del cliente guardó.'));
  const input = h('textarea', { placeholder: 'Escribe como si fueras el cliente…', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  const btn = h('button', { class: 'primary', onclick: () => send() }, 'Enviar');

  const bubble = (cls, content, img) =>
    h('div', { class: `bubble ${cls}` }, img ? h('img', { src: `/api/images/${img.id}/file` }) : null, img ? h('div', { class: 'small muted' }, `🖼 ${img.code}`) : null, content || null);

  const load = async () => {
    const d = await api('GET', `/api/chatbots/${bot.id}/playground/${session}`);
    fill(chat, ...d.messages.map((m) => bubble(m.sender === 'system' ? 'notify' : m.direction === 'in' ? 'in' : 'out', m.content, m.image_id ? { id: m.image_id, code: m.image_code } : null)));
    chat.scrollTop = chat.scrollHeight;
  };

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    chat.append(bubble('in', text));
    chat.scrollTop = chat.scrollHeight;
    btn.disabled = true;
    btn.textContent = 'Pensando…';
    const r = await run(() => api('POST', `/api/chatbots/${bot.id}/playground`, { session, text }));
    btn.disabled = false;
    btn.textContent = 'Enviar';
    if (!r) return;
    // Historial completo: incluye respuestas de reglas automáticas y notas del simulador.
    await load();
    for (const o of r.outputs.filter((x) => x.type === 'notify')) chat.append(bubble('notify', o.text));
    if (r.result.status === 'no_reply') chat.append(bubble('notify', '(la IA decidió no responder)'));
    if (r.result.status === 'human') chat.append(bubble('notify', '(conversación en modo humano: el bot no responde)'));
    if (r.result.status === 'error') chat.append(bubble('notify', `Error: ${r.result.error}`));
    chat.scrollTop = chat.scrollHeight;
    const c = r.contact || {};
    const attempts = r.result.attempts || [];
    const fixes = attempts.flatMap((a) => a.fixes);
    const rejected = attempts.filter((a) => a.retryable.length);
    const dataLabels = Object.fromEntries((bot.data_fields || []).map((f) => [f.key, f.label]));
    fill(debug,
      h('div', {}, h('strong', {}, 'Qué hizo: '), ACTION_LABEL[r.result.action] || ACTION_LABEL[r.result.status] || r.result.status,
        r.result.fallback_used ? h('div', { class: 'small' }, h('span', { class: 'badge orange' }, 'mensaje de respaldo'), ' La IA no logró una respuesta comprobable y se envió tu mensaje de respaldo.') : null,
        r.result.info_not_found ? h('div', { class: 'small' }, h('span', { class: 'badge orange' }, 'dato no encontrado'), ' Le preguntaron algo que no está en "Lo que sabe". Agrégalo si quieres que lo responda.') : null),
      h('div', {}, h('strong', {}, 'Revisión de reglas: '),
        !rejected.length && !fixes.length ? h('span', { class: 'badge green' }, '✓ cumplió todo a la primera') : null,
        rejected.length ? h('div', { class: 'small' }, h('span', { class: 'badge orange' }, `${rejected.length} ${rejected.length === 1 ? 'respuesta rehecha' : 'respuestas rehechas'}`), h('ul', { class: 'muted' }, [...new Set(rejected.flatMap((a) => a.retryable).map(explainIssue))].map((x) => h('li', {}, x)))) : null,
        fixes.length ? h('div', { class: 'small' }, h('span', { class: 'badge' }, 'ajustes automáticos'), h('ul', { class: 'muted' }, fixes.map((x) => h('li', {}, x)))) : null),
      h('div', {}, h('strong', {}, 'Conversación: '), r.conversation?.status === 'human' ? h('span', { class: 'badge orange' }, 'pasó con una persona (el asistente ya no responde)') : h('span', { class: 'badge green' }, 'la atiende el asistente')),
      h('div', {}, h('strong', {}, 'Datos del cliente: '),
        c.name || Object.keys(c.data || {}).length
          ? h('ul', { class: 'small' }, c.name ? h('li', {}, 'Nombre: ', c.name) : null, Object.entries(c.data || {}).map(([k, v]) => h('li', {}, `${dataLabels[k] || k}: ${v}`)))
          : h('span', { class: 'muted small' }, 'aún ninguno')),
      c.notes?.length ? h('div', {}, h('strong', {}, 'Lo que recuerda: '), h('ul', { class: 'small' }, c.notes.map((n) => h('li', {}, n)))) : null,
      r.result.thinking ? h('details', { class: 'small' }, h('summary', {}, 'Por qué respondió así'), h('p', { class: 'muted' }, r.result.thinking)) : null,
      r.conversation?.summary ? h('details', { class: 'small' }, h('summary', {}, 'Resumen de memoria'), h('div', { class: 'pre muted' }, r.conversation.summary)) : null,
    );
  };

  const reset = async () => {
    await run(() => api('DELETE', `/api/chatbots/${bot.id}/playground/${session}`), 'Conversación reiniciada');
    const ns = Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('pg-session', ns); } catch { /* */ }
    render();
  };

  root.append(
    h('div', { class: 'split' },
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Simulador'), h('button', { class: 'small', onclick: reset }, 'Reiniciar conversación')),
        h('p', { class: 'muted small' }, 'Escribe como si fueras un cliente. Responde exactamente igual que en WhatsApp, con las mismas reglas (funciona aunque esté apagado). Las fotos se muestran aquí en lugar de enviarse.'),
        chat,
        h('div', { class: 'row', style: 'margin:8px 0;gap:6px;flex-wrap:wrap' }, h('span', { class: 'small muted' }, 'Prueba:'),
          TEST_IDEAS.map((q) => h('button', { class: 'small', onclick: () => { input.value = q; send(); } }, q))),
        h('div', { class: 'composer' }, input, btn)),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Qué revisó el sistema'), debug),
    ),
  );
  load().catch(() => undefined);
  input.focus();
}

/* ------------------------------ Conversaciones ------------------------------ */

const STATUS_BADGE = { bot: ['green', 'Bot'], human: ['orange', 'Humano'], closed: ['', 'Cerrada'] };

async function viewConversations(root, params) {
  const [bots, channels] = await Promise.all([api('GET', `/api/chatbots${acct()}`), api('GET', `/api/channels${acct()}`)]);
  const f = {
    chatbot_id: params.get('chatbot_id') || '',
    channel_id: params.get('channel_id') || '',
    channel_type: params.get('channel_type') || '',
    status: params.get('status') || '',
    search: params.get('search') || '',
  };
  const apply = () => { location.hash = `#/conversations?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`; };
  const table = h('tbody');
  const showAccount = isSuper() && !state.accountId;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    if (isSuper() && state.accountId) qs.set('account_id', state.accountId);
    const rows = await api('GET', `/api/conversations?${qs}`);
    fill(table,
      ...(rows.length ? rows.map((c) => {
        const [cls, label] = STATUS_BADGE[c.status] || ['', c.status];
        return h('tr', { class: 'click', onclick: () => (location.hash = `#/conversation/${c.id}`) },
          h('td', {}, h('strong', {}, c.name || c.push_name || (c.channel_type === 'webchat' ? 'Visitante del sitio' : 'Sin nombre')), h('div', { class: 'muted small' }, c.phone ? `+${c.phone}` : '')),
          h('td', {}, channelIcon(c.channel_type), ' ', c.channel_name, h('div', { class: 'muted small' }, c.chatbot_name || 'sin chatbot')),
          showAccount ? h('td', { class: 'small' }, c.account_name) : null,
          h('td', {}, h('span', { class: `badge ${cls}` }, label), c.status === 'human' && c.handoff_reason ? h('div', { class: 'muted small' }, c.handoff_reason) : null),
          h('td', { class: 'muted' }, (c.last_message || '').slice(0, 90)),
          h('td', { class: 'muted small' }, fmtDate(c.last_message_at)));
      }) : [h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No hay conversaciones.'))]),
    );
  };
  const types = state.meta.channel_types.map((t) => [t.type, t.label]);
  root.append(
    h('h1', {}, 'Conversaciones'),
    h('div', { class: 'card row' },
      h('div', { style: 'min-width:170px' }, select(f, 'chatbot_id', [['', 'Todos los chatbots'], ...bots.map((b) => [b.id, b.name])], apply)),
      h('div', { style: 'min-width:150px' }, select(f, 'channel_type', [['', 'Todas las plataformas'], ...types], apply)),
      h('div', { style: 'min-width:150px' }, select(f, 'channel_id', [['', 'Todos los canales'], ...channels.map((c) => [c.id, c.name])], apply)),
      h('div', { style: 'min-width:150px' }, select(f, 'status', [['', 'Todos los estados'], ['bot', 'Atendidas por bot'], ['human', 'Con humano'], ['closed', 'Cerradas']], apply)),
      h('div', { style: 'flex:1;min-width:160px' }, h('input', { type: 'search', placeholder: 'Buscar nombre o teléfono…', value: f.search, onchange: (e) => { f.search = e.target.value; apply(); } }))),
    h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Cliente'), h('th', {}, 'Canal'), showAccount ? h('th', {}, 'Cuenta') : null, h('th', {}, 'Estado'), h('th', {}, 'Último mensaje'), h('th', {}, 'Fecha'))), table)),
  );
  await load();
  state.timers.push(setInterval(() => load().catch(() => undefined), 10000));
}

async function viewConversation(root, id) {
  const chat = h('div', { class: 'chat' });
  const side = h('div');
  const header = h('div');
  const input = h('textarea', { placeholder: 'Escribe como persona del equipo… (Enter para enviar)', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  let lastCount = -1;
  let data;

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    const ok = await run(() => api('POST', `/api/conversations/${id}/send`, { text }));
    if (ok) { input.value = ''; await load(true); }
  };

  const load = async (force = false) => {
    data = await api('GET', `/api/conversations/${id}`);
    const { conversation: c, contact: ct, messages } = data;
    const [cls, label] = STATUS_BADGE[c.status] || ['', c.status];
    fill(header, 
      h('div', { class: 'row between' },
        h('h1', {}, ct.name || ct.push_name || 'Cliente', ' ', h('span', { class: `badge ${cls}` }, label)),
        h('div', { class: 'row' },
          c.status !== 'human' ? h('button', { class: 'primary', onclick: async () => { await run(() => api('POST', `/api/conversations/${id}/takeover`), 'Tomaste la conversación'); load(true); } }, 'Tomar conversación') : null,
          c.status !== 'bot' ? h('button', { class: 'primary', onclick: async () => { await run(() => api('POST', `/api/conversations/${id}/release`), 'El bot vuelve a responder'); load(true); } }, 'Devolver al bot') : null,
          c.status !== 'closed' ? h('button', { onclick: async () => { await run(() => api('POST', `/api/conversations/${id}/close`), 'Cerrada'); load(true); } }, 'Cerrar') : null)),
      h('p', { class: 'muted' }, channelIcon(data.channel?.type), ' ', data.channel?.name, ' · ', data.chatbot?.name || 'sin chatbot', ct.phone ? ` · +${ct.phone}` : '', c.status === 'human' && c.handoff_reason ? ` · Motivo: ${c.handoff_reason}` : ''),
    );
    if (force || messages.length !== lastCount) {
      lastCount = messages.length;
      fill(chat, ...messages.map((m) => {
        const cls = ['bubble', m.direction === 'in' ? 'in' : 'out', m.sender === 'human' ? 'human' : '', m.status === 'failed' ? 'failed' : ''].join(' ');
        const who = m.sender === 'human' ? '👤 equipo' : m.sender === 'bot' ? '🤖 bot' : '';
        return h('div', { class: cls },
          m.image_id ? h('img', { src: `/api/images/${m.image_id}/file`, alt: m.image_name || '' }) : null,
          m.image_id ? h('div', { class: 'small muted' }, `🖼 ${m.image_code || ''}`) : null,
          m.content || null,
          h('div', { class: 'meta' }, [who, fmtDate(m.created_at), m.status === 'failed' ? '⚠️ no enviado' : '', m.meta?.fallback ? 'respaldo' : ''].filter(Boolean).join(' · ')));
      }));
      chat.scrollTop = chat.scrollHeight;
    }
    if (force || !side.contains(document.activeElement)) drawSide();
  };

  const autoBox = h('div');
  /** Secuencias, citas y envíos programados de esta conversación. */
  const drawAuto = async () => {
    const [auto, seqs, services] = await Promise.all([
      api('GET', `/api/conversations/${id}/automation`),
      api('GET', withAcct('/api/sequences')).catch(() => []),
      api('GET', withAcct('/api/services')).catch(() => []),
    ]);
    const enr = { sequence_id: seqs.find((q) => q.active)?.id || '' };
    const book = { service_id: services.find((q) => q.active)?.id || '', slot: '', notes: '' };
    const slotBox = h('div');
    const loadSlots = async () => {
      if (!book.service_id) return;
      const slots = await api('GET', `/api/services/${book.service_id}/slots`);
      book.slot = slots[0]?.key || '';
      fill(slotBox, slots.length ? select(book, 'slot', slots.map((x) => [x.key, x.label])) : h('p', { class: 'small muted' }, 'Sin horarios disponibles'));
    };
    const active = auto.enrollments.filter((e) => e.status === 'active');
    const upcoming = auto.appointments.filter((a) => a.status === 'confirmed' && new Date(a.starts_at) > new Date());
    const JOB_LABEL = { sequence_step: 'Mensaje de secuencia', no_reply: 'Seguimiento si no responde', automation_send: 'Mensaje programado', appointment_reminder: 'Recordatorio de cita', campaign_send: 'Campaña' };
    fill(autoBox,
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'Citas'),
        upcoming.length ? upcoming.map((a) => h('div', { class: 'small' }, a.kind === 'call' ? '📞 ' : '📅 ', h('strong', {}, a.service_name), ` · ${fmtDate(a.starts_at)}`)) : h('p', { class: 'small muted', style: 'margin:0' }, 'Sin citas próximas'),
        services.length ? h('details', { style: 'margin-top:8px' }, h('summary', {}, 'Agendar cita o llamada'),
          field('Servicio', select(book, 'service_id', services.filter((q) => q.active).map((q) => [q.id, q.name]), loadSlots)),
          slotBox,
          field('Notas', text(book, 'notes')),
          h('button', { class: 'small primary', onclick: async () => { if (await run(() => api('POST', '/api/appointments', { ...book, conversation_id: id }), 'Agendada: se envió la confirmación al cliente')) { drawAuto(); load(true); } } }, 'Agendar y avisar al cliente')) : null),
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'Secuencias'),
        active.length ? active.map((e) => h('div', { class: 'row between small' }, h('span', {}, `▶ ${e.sequence_name} (paso ${e.current_step + 1})`),
          h('button', { class: 'small danger', onclick: async () => { await run(() => api('DELETE', `/api/conversations/${id}/sequences/${e.sequence_id}`), 'Detenida'); drawAuto(); } }, 'Detener'))) : h('p', { class: 'small muted', style: 'margin:0' }, 'Ninguna en curso'),
        seqs.length ? h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { style: 'flex:1' }, select(enr, 'sequence_id', seqs.filter((q) => q.active).map((q) => [q.id, q.name]))),
          h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/conversations/${id}/sequences`, enr), 'Inscrito en la secuencia')) drawAuto(); } }, 'Iniciar')) : null,
        auto.jobs.length ? h('details', { style: 'margin-top:8px' }, h('summary', {}, `Envíos programados (${auto.jobs.length})`),
          auto.jobs.map((j) => h('div', { class: 'small muted' }, `${fmtDate(j.run_at)} · ${JOB_LABEL[j.type] || j.type}`))) : null),
    );
    if (services.length) loadSlots();
  };

  const drawSide = () => {
    const { conversation: c, contact: ct } = data;
    const m = { name: ct.name, data: { ...ct.data }, notes: [...(ct.notes || [])], tags: [...(ct.tags || [])], opted_out: !!ct.opted_out };
    const fieldsDef = data.chatbot?.data_fields || [];
    // Los campos de tipo "nombre" se editan en el campo Nombre del contacto.
    const nameKeys = fieldsDef.filter((f) => f.type === 'name').map((f) => f.key);
    const keys = [...new Set([...fieldsDef.map((f) => f.key), ...Object.keys(ct.data || {})])].filter((k) => !nameKeys.includes(k));
    fill(side, 
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'Datos del cliente'),
        field('Nombre', text(m, 'name')),
        ...keys.map((k) => field(fieldsDef.find((f) => f.key === k)?.label || k, text(m.data, k))),
        field('Notas (memoria)', lines(m, 'notes')),
        field('Etiquetas', h('input', { type: 'text', value: m.tags.join(', '), placeholder: 'vip, interesado', oninput: (e) => (m.tags = e.target.value.split(',').map((x) => x.trim()).filter(Boolean)) }), 'Separadas por comas. Sirven para campañas y reglas.'),
        check(m, 'opted_out', 'Dado de baja (no recibe mensajes promocionales)'),
        h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/contacts/${ct.id}`, { ...m, data: Object.fromEntries(Object.entries({ ...m.data, ...Object.fromEntries(nameKeys.map((k) => [k, m.name])) }).filter(([, v]) => v)) }), 'Datos guardados')) load(true); } }, 'Guardar datos')),
      flowCard(data.chatbot?.flow, c),
      autoBox,
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'Resumen de memoria'),
        h('div', { class: 'small pre muted' }, c.summary || 'Aún no hay resumen (se genera cuando la conversación crece).'),
        h('button', { class: 'small danger', style: 'margin-top:10px', onclick: async () => { if (confirm('¿Borrar memoria (resumen, datos y notas) de este cliente?')) { await run(() => api('POST', `/api/conversations/${id}/reset-memory`), 'Memoria borrada'); load(true); } } }, 'Borrar memoria')),
      isAdmin() ? h('div', { class: 'card' }, h('a', { href: `#/logs?conversation_id=${id}` }, 'Ver registros de esta conversación →')) : null,
    );
  };

  root.append(
    h('a', { href: '#/conversations' }, '← Conversaciones'),
    header,
    h('div', { class: 'split' },
      h('div', { class: 'card' }, chat, h('div', { class: 'composer' }, input, h('button', { class: 'primary', onclick: send }, 'Enviar')),
        h('p', { class: 'muted small' }, 'Al enviar un mensaje manual, el bot se pausa en esta conversación hasta que la devuelvas.')),
      side),
  );
  await load(true);
  drawAuto().catch(() => undefined);
  state.timers.push(setInterval(() => load().catch(() => undefined), 5000));
}

/* ------------------------------ Registros ------------------------------ */

async function viewLogs(root, params) {
  const bots = await api('GET', `/api/chatbots${acct()}`);
  const f = { chatbot_id: params.get('chatbot_id') || '', channel_id: params.get('channel_id') || '', level: params.get('level') || '', source: params.get('source') || '', conversation_id: params.get('conversation_id') || '' };
  const apply = () => { location.hash = `#/logs?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`; };
  const botName = Object.fromEntries(bots.map((b) => [b.id, b.name]));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  if (isSuper() && state.accountId) qs.set('account_id', state.accountId);
  const rows = await api('GET', `/api/logs?${qs}`);
  root.append(
    h('h1', {}, 'Registros'),
    h('div', { class: 'card row' },
      h('div', { style: 'min-width:180px' }, select(f, 'chatbot_id', [['', 'Todos los chatbots'], ...bots.map((b) => [b.id, b.name])], apply)),
      h('div', { style: 'min-width:140px' }, select(f, 'level', [['', 'Todos los niveles'], ['error', 'Errores'], ['warn', 'Advertencias'], ['info', 'Información']], apply)),
      h('div', { style: 'min-width:160px' }, select(f, 'source', [['', 'Todos los componentes'], ['evolution', 'Evolution (WhatsApp)'], ['channel', 'Canales'], ['ai', 'IA'], ['validator', 'Validador'], ['engine', 'Motor'], ['webhook', 'Webhook'], ['admin', 'Panel'], ['system', 'Sistema']], apply)),
      f.conversation_id ? h('span', { class: 'badge' }, 'filtrado por conversación ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); f.conversation_id = ''; apply(); } }, '✕')) : null,
      f.channel_id ? h('span', { class: 'badge' }, 'filtrado por canal ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); f.channel_id = ''; apply(); } }, '✕')) : null,
      h('button', { onclick: render }, 'Actualizar')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Fecha'), h('th', {}, 'Nivel'), h('th', {}, 'Componente'), h('th', {}, 'Chatbot'), h('th', {}, 'Mensaje'))),
        h('tbody', {}, rows.map((r) =>
          h('tr', { class: `log-${r.level}` },
            h('td', { class: 'small' }, fmtDate(r.created_at)),
            h('td', {}, r.level),
            h('td', {}, r.source),
            h('td', { class: 'small' }, botName[r.chatbot_id] || ''),
            h('td', {}, r.message,
              r.conversation_id ? h('div', {}, h('a', { class: 'small', href: `#/conversation/${r.conversation_id}` }, 'ver conversación')) : null,
              r.details && Object.keys(r.details).length ? h('details', {}, h('summary', {}, 'detalles'), h('pre', { class: 'small pre' }, JSON.stringify(r.details, null, 2))) : null)))))),
  );
}

/* ------------------------------ Canales ------------------------------ */

const CHANNEL_ICONS = { whatsapp: '🟢', telegram: '✈️', messenger: '💬', instagram: '📸', webchat: '🌐', playground: '🧪' };
function channelIcon(type) {
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

async function viewChannels(root, params) {
  const [channels, bots] = await Promise.all([api('GET', `/api/channels${acct()}`), api('GET', `/api/chatbots${acct()}`)]);
  const types = state.meta.channel_types;
  const n = { type: 'whatsapp', name: '', chatbot_id: params.get('chatbot_id') || '' };
  const botOptions = () => [['', '— Sin chatbot (solo guarda mensajes) —'], ...bots.filter((b) => !isSuper() || !n.account_id || b.account_id === n.account_id).map((b) => [b.id, b.name])];
  const botSelect = h('div');
  const drawBots = () => fill(botSelect, field('Chatbot que responde', select(n, 'chatbot_id', botOptions())));
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
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Canales'), h('button', { class: 'primary', onclick: () => (createBox.hidden = !createBox.hidden) }, '+ Nuevo canal')),
    h('div', { class: 'card' }, h('p', { class: 'muted', style: 'margin:0' },
      'Cada canal es una conexión con una plataforma (un número de WhatsApp, un bot de Telegram, una página de Facebook, una cuenta de Instagram o el chat de un sitio web). ',
      'Asígnale un chatbot para que responda; un mismo chatbot puede atender varios canales.')),
    !state.meta.public_https ? h('div', { class: 'card' }, h('span', { class: 'badge orange' }, 'Aviso'), ' ',
      `La URL pública (${state.meta.public_base_url}) no es HTTPS. Telegram, Messenger e Instagram exigen HTTPS: define PUBLIC_BASE_URL con tu dominio.`) : null,
    createBox,
    h('div', { class: 'card' },
      channels.length
        ? h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Canal'), h('th', {}, 'Plataforma'), h('th', {}, 'Chatbot'), isSuper() && !state.accountId ? h('th', {}, 'Cuenta') : null, h('th', {}, 'Estado'))),
            h('tbody', {}, channels.map((c) => h('tr', { class: 'click', onclick: () => (location.hash = `#/channel/${c.id}`) },
              h('td', {}, channelIcon(c.type), ' ', h('strong', {}, c.name)),
              h('td', {}, c.label),
              h('td', {}, c.chatbot_id ? botName[c.chatbot_id] || '—' : h('span', { class: 'badge orange' }, 'sin chatbot')),
              isSuper() && !state.accountId ? h('td', { class: 'small' }, accountName(c.account_id)) : null,
              h('td', {}, h('span', { class: `badge ${c.active ? 'green' : ''}` }, c.active ? 'Activo' : 'Inactivo'))))))
        : h('p', { class: 'muted' }, 'Aún no hay canales.')),
  );
}

/** Campos de configuración de cada plataforma. */
function channelConfigFields(ch, cfg) {
  const secret = (key, label, help) => field(label, h('input', { type: 'password', autocomplete: 'off', value: cfg[key] || '', placeholder: cfg[key] ? '' : 'Pega aquí el valor', oninput: (e) => (cfg[key] = e.target.value) }), help);
  switch (ch.type) {
    case 'whatsapp':
      if (!isSuper()) {
        return [field('Número de WhatsApp', text(cfg, 'number', { placeholder: '5215512345678' }), 'Con lada de país; opcional, como referencia. Conecta tu WhatsApp con el código QR de abajo.')];
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

async function viewChannel(root, id) {
  const [ch, bots] = await Promise.all([api('GET', `/api/channels/${id}`), api('GET', '/api/chatbots')]);
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
    if (updated) render();
  };
  const setup = async () => {
    const r = await run(() => api('POST', `/api/channels/${id}/setup`));
    if (!r) return;
    fill(result, h('p', {}, h('span', { class: `badge ${r.ok ? 'green' : 'orange'}` }, r.ok ? 'Listo' : 'Atención'), ' ', r.message));
    refresh();
  };
  const copyBtn = (value) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(value); toast('Copiado'); } catch { toast('No se pudo copiar', true); } } }, 'Copiar');

  const connection = [];
  if (ch.type === 'whatsapp') {
    const qrBox = h('div');
    const test = { number: '', text: 'Mensaje de prueba ✅' };
    const connect = async () => {
      const r = await run(() => api('POST', `/api/channels/${id}/whatsapp/connect`));
      if (!r) return;
      if (r.state === 'open') { fill(qrBox, h('p', {}, '✅ Ya está conectado. Webhook actualizado.')); return refresh(); }
      const src = r.qr ? (r.qr.startsWith('data:') ? r.qr : `data:image/png;base64,${r.qr}`) : null;
      fill(qrBox,
        h('p', {}, 'Abre WhatsApp en el teléfono → Dispositivos vinculados → Vincular dispositivo, y escanea:'),
        src ? h('img', { class: 'qr', src }) : h('p', { class: 'muted' }, 'Evolution no devolvió QR; vuelve a intentar.'),
        r.pairingCode ? h('p', {}, 'Código de vinculación: ', h('code', {}, r.pairingCode)) : null);
      refresh();
    };
    connection.push(
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: connect }, 'Conectar / mostrar QR'),
        h('button', { onclick: setup }, 'Reconfigurar webhook'),
        h('button', { class: 'danger', onclick: async () => { if (confirm('¿Desvincular este WhatsApp?')) { await run(() => api('POST', `/api/channels/${id}/whatsapp/logout`), 'Desconectado'); refresh(); } } }, 'Desconectar')),
      qrBox,
      h('h3', {}, 'Mensaje de prueba'),
      h('div', { class: 'grid' }, field('Número (con lada)', text(test, 'number', { placeholder: '5215512345678' })), field('Texto', text(test, 'text'))),
      h('button', { onclick: () => run(() => api('POST', `/api/channels/${id}/whatsapp/test`, test), 'Enviado') }, 'Enviar'),
    );
  } else if (ch.type === 'telegram') {
    connection.push(
      h('p', { class: 'muted small' }, 'Al conectar se valida el token y se registra el webhook en Telegram automáticamente.'),
      h('button', { class: 'primary', onclick: setup, disabled: !ch.config.bot_token }, 'Conectar con Telegram'),
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
  } else if (ch.type === 'webchat') {
    connection.push(
      h('p', {}, 'Pega este código antes de ', h('code', {}, '</body>'), ' en el sitio web:'),
      h('pre', { class: 'small pre', style: 'background:var(--bg);padding:10px;border-radius:8px' }, ch.embed_code),
      h('div', { class: 'row' }, copyBtn(ch.embed_code), h('a', { class: 'btn', href: `/webchat-demo.html?channel=${encodeURIComponent(ch.webhook_token)}`, target: '_blank', rel: 'noopener' }, 'Vista previa')),
    );
  }

  root.append(
    h('a', { href: '#/channels' }, '← Canales'),
    h('div', { class: 'row between' },
      h('h1', {}, channelIcon(ch.type), ' ', ch.name, ' ', h('span', { class: `badge ${ch.active ? 'green' : ''}` }, ch.active ? 'Activo' : 'Inactivo')),
      h('a', { href: `#/conversations?channel_id=${ch.id}` }, 'Ver conversaciones →')),
    h('p', { class: 'muted' }, ch.label, isSuper() ? ` · ${accountName(ch.account_id)}` : ''),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'General'),
      field('Nombre', text(m, 'name')),
      field('Chatbot que responde', select(m, 'chatbot_id', [['', '— Sin chatbot (solo guarda mensajes) —'], ...accountBots.map((b) => [b.id, b.name])])),
      check(m, 'active', 'Activo (si se desactiva, los mensajes se guardan pero no se responden)')),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Configuración'), channelConfigFields(ch, cfg)),
    h('div', { class: 'card' },
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
          location.hash = '#/channels';
        }
      } }, 'Eliminar canal'))),
  );
  refresh();
}

/* ------------------------------ Usuarios ------------------------------ */

async function viewUsers(root) {
  const users = await api('GET', `/api/users${acct()}`);
  const n = { name: '', email: '', password: '', role: 'agent', phone: '', notify_whatsapp: false };
  const roles = [['agent', 'Agente (solo conversaciones)'], ['admin', 'Administrador de la cuenta']];
  if (isSuper()) roles.push(['superadmin', 'Superadministrador (todas las cuentas)']);
  const me = state.me.user;
  root.append(
    h('h1', {}, 'Usuarios'),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Nuevo usuario'),
      h('div', { class: 'grid' },
        field('Nombre', text(n, 'name')),
        field('Correo', text(n, 'email', { placeholder: 'persona@empresa.com' })),
        field('Contraseña inicial', text(n, 'password', { type: 'password' }), 'Mínimo 8 caracteres. Pídele que la cambie al entrar.'),
        field('Rol', select(n, 'role', roles)),
        field('WhatsApp para alertas (opcional)', text(n, 'phone', { placeholder: '5215512345678' }))),
      check(n, 'notify_whatsapp', 'Enviarle las alertas también por WhatsApp'),
      accountPicker(n),
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', '/api/users', n), 'Usuario creado')) render(); } }, 'Crear usuario')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Usuario'), h('th', {}, 'Rol'), isSuper() ? h('th', {}, 'Cuenta') : null, h('th', {}, 'Último acceso'), h('th', {}, ''))),
        h('tbody', {}, users.map((u) => {
          const self = u.id === me.id;
          return h('tr', {},
            h('td', {}, h('strong', {}, u.name || '—'), h('div', { class: 'muted small' }, u.email, u.phone ? ` · 📱 +${u.phone}${u.notify_whatsapp ? ' (alertas)' : ''}` : ''), !u.active ? h('span', { class: 'badge orange' }, 'desactivado') : null),
            h('td', {}, u.role === 'superadmin' || self ? ROLE_LABEL[u.role]
              : h('select', { onchange: async (e) => { if (await run(() => api('PUT', `/api/users/${u.id}`, { role: e.target.value }), 'Rol actualizado')) render(); } },
                  [['agent', 'Agente'], ['admin', 'Administrador']].map(([v, l]) => h('option', { value: v, selected: u.role === v }, l)))),
            isSuper() ? h('td', { class: 'small' }, u.account_id ? accountName(u.account_id) : '—') : null,
            h('td', { class: 'small muted' }, u.last_login_at ? fmtDate(u.last_login_at) : 'nunca'),
            h('td', {}, self ? h('span', { class: 'muted small' }, 'tú') : h('div', { class: 'row' },
              h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/users/${u.id}`, { active: !u.active }), u.active ? 'Desactivado' : 'Activado')) render(); } }, u.active ? 'Desactivar' : 'Activar'),
              h('button', { class: 'small', onclick: async () => { const pw = prompt('Nueva contraseña (mínimo 8 caracteres)'); if (pw) await run(() => api('PUT', `/api/users/${u.id}`, { password: pw }), 'Contraseña actualizada'); } }, 'Restablecer contraseña'),
              h('button', { class: 'small', onclick: async () => {
                const phone = prompt('WhatsApp para alertas (con lada; vacío para quitar)', u.phone || '');
                if (phone !== null && (await run(() => api('PUT', `/api/users/${u.id}`, { phone, notify_whatsapp: !!phone.replace(/\D/g, '') }), 'Actualizado'))) render();
              } }, 'Alertas WhatsApp'),
              h('button', { class: 'small danger', onclick: async () => { if (confirm(`¿Eliminar a ${u.email}?`)) { await run(() => api('DELETE', `/api/users/${u.id}`), 'Eliminado'); render(); } } }, 'Eliminar'))));
        })))),
  );
}

/* ------------------------------ Cuentas ------------------------------ */

async function viewAccounts(root) {
  const accounts = await api('GET', '/api/accounts');
  state.accounts = accounts;
  const n = { name: '', withAdmin: true, admin: { name: '', email: '', password: '' } };
  const adminBox = h('div', {},
    h('div', { class: 'grid' },
      field('Nombre del administrador', text(n.admin, 'name')),
      field('Correo', text(n.admin, 'email', { placeholder: 'dueño@cliente.com' })),
      field('Contraseña inicial', text(n.admin, 'password', { type: 'password' }), 'Mínimo 8 caracteres.')));
  root.append(
    h('h1', {}, 'Cuentas'),
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Cada cuenta es un cliente con sus propios usuarios, chatbots, canales y conversaciones. Sus usuarios solo ven lo de su cuenta.'),
      h('h3', {}, 'Nueva cuenta'),
      field('Nombre del cliente', text(n, 'name', { placeholder: 'Hotel Las Palmas' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { n.withAdmin = e.target.checked; adminBox.hidden = !n.withAdmin; } }), 'Crear también su primer administrador'),
      adminBox,
      h('button', { class: 'primary', onclick: async () => {
        const body = { name: n.name, ...(n.withAdmin ? { admin: n.admin } : {}) };
        const acc = await run(() => api('POST', '/api/accounts', body), 'Cuenta creada');
        if (acc) { state.accountId = acc.id; try { localStorage.setItem('cp-account', acc.id); } catch { /* */ } state.me = null; render(); }
      } }, 'Crear cuenta')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Cuenta'), h('th', {}, 'Estado'), h('th', {}, 'WhatsApp'), h('th', { class: 'num' }, 'Conversaciones (mes / total)'), h('th', { class: 'num' }, 'IA (mes)'), h('th', {}, 'Última actividad'), h('th', {}, ''))),
        h('tbody', {}, accounts.map((a) => h('tr', {},
          h('td', {}, h('strong', {}, a.name),
            a.owner_email ? h('div', { class: 'small muted' }, a.owner_email, a.owner_verified === false ? ' (sin confirmar)' : '') : null,
            h('div', { class: 'small muted' }, `${a.chatbots} bots · ${a.channels} canales · ${a.users} usuarios${a.signup_source === 'signup' ? ' · registro propio' : ''}`)),
          h('td', {}, statusBadge(a)),
          h('td', {}, a.whatsapp_state ? h('span', { class: `badge ${a.whatsapp_state === 'open' ? 'green' : 'orange'}` }, { open: 'conectado', close: 'desconectado', connecting: 'conectando' }[a.whatsapp_state] || a.whatsapp_state) : h('span', { class: 'muted small' }, '—')),
          h('td', { class: 'num' }, `${a.conversations_month} / ${a.conversations}`),
          h('td', { class: 'num' }, usd(a.ai_cost_month)),
          h('td', { class: 'small' }, a.last_activity_at ? fmtDate(a.last_activity_at) : '—'),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'small', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } location.hash = '#/'; } }, 'Abrir'),
            a.status !== 'active' ? h('button', { class: 'small primary', onclick: async () => {
              const plan = prompt('Plan contratado (opcional)', a.plan || '');
              if (plan === null) return;
              await run(() => api('PUT', `/api/accounts/${a.id}`, { status: 'active', plan }), 'Cuenta activada');
              render();
            } }, 'Activar plan') : h('button', { class: 'small', onclick: async () => {
              if (!confirm(`¿Pausar "${a.name}"? Su asistente deja de responder, pero pueden entrar al panel.`)) return;
              await run(() => api('PUT', `/api/accounts/${a.id}`, { status: 'paused' }), 'Cuenta en pausa');
              render();
            } }, 'Pausar'),
            a.status !== 'active' ? h('button', { class: 'small', onclick: async () => {
              const d = Number(prompt('¿Cuántos días más de prueba?', '7'));
              if (d > 0) { await run(() => api('PUT', `/api/accounts/${a.id}`, { extend_trial_days: d }), 'Prueba extendida'); render(); }
            } }, 'Extender prueba') : null,
            h('button', { class: 'small', onclick: async () => { const name = prompt('Nuevo nombre', a.name); if (name) { await run(() => api('PUT', `/api/accounts/${a.id}`, { name }), 'Actualizada'); state.me = null; render(); } } }, 'Renombrar'),
            h('button', { class: 'small', onclick: async () => {
              if (a.active && !confirm(`Al desactivar "${a.name}", sus usuarios no podrán entrar y sus canales dejarán de responder (los mensajes se siguen guardando). ¿Continuar?`)) return;
              await run(() => api('PUT', `/api/accounts/${a.id}`, { active: !a.active }), a.active ? 'Cuenta desactivada' : 'Cuenta activada');
              state.me = null;
              render();
            } }, a.active ? 'Desactivar' : 'Activar'),
            h('button', { class: 'small danger', onclick: async () => {
              if (prompt(`Esto borra TODO de "${a.name}" (chatbots, canales, usuarios y conversaciones). Escribe el nombre para confirmar`) === a.name) {
                await run(() => api('DELETE', `/api/accounts/${a.id}`), 'Cuenta eliminada');
                if (state.accountId === a.id) state.accountId = '';
                state.me = null;
                render();
              }
            } }, 'Eliminar')))))))),
  );
}

/* ------------------------------ Contraseña ------------------------------ */

async function viewPassword(root) {
  const f = { current: '', password: '', confirm: '' };
  const me = { name: state.me.user.name, phone: state.me.user.phone || '', notify_whatsapp: !!state.me.user.notify_whatsapp };
  root.append(
    h('h1', {}, 'Mi perfil'),
    h('div', { class: 'card', style: 'max-width:420px' },
      field('Nombre', text(me, 'name')),
      field('WhatsApp para alertas', text(me, 'phone', { placeholder: '5215512345678' })),
      check(me, 'notify_whatsapp', 'Recibir las alertas del equipo por WhatsApp'),
      h('button', { onclick: async () => { const u = await run(() => api('PUT', '/api/me', me), 'Perfil guardado'); if (u) state.me.user = { ...state.me.user, ...u }; } }, 'Guardar perfil')),
    h('h2', {}, 'Cambiar contraseña'),
    h('div', { class: 'card', style: 'max-width:420px' },
      field('Contraseña actual', text(f, 'current', { type: 'password' })),
      field('Nueva contraseña', text(f, 'password', { type: 'password' }), 'Mínimo 8 caracteres. Se cerrarán tus otras sesiones abiertas.'),
      field('Repite la nueva contraseña', text(f, 'confirm', { type: 'password' })),
      h('button', { class: 'primary', onclick: async () => {
        if (f.password !== f.confirm) return toast('Las contraseñas no coinciden', true);
        if (await run(() => api('PUT', '/api/me/password', { current: f.current, password: f.password }), 'Contraseña actualizada')) render();
      } }, 'Guardar')),
  );
}

/* ============================== Automatización ============================== */

/** El superadmin debe elegir una cuenta para configurar automatización y agenda. */
function needAccount(root) {
  if (!isSuper() || state.accountId) return false;
  root.append(h('div', { class: 'card' }, h('p', {}, 'Elige una cuenta en el selector del menú para configurar su automatización y agenda.')));
  return true;
}
const withAcct = (url) => url + (isSuper() && state.accountId ? `${url.includes('?') ? '&' : '?'}account_id=${state.accountId}` : '');

const AUTO_TABS = [['rules', 'Reglas'], ['sequences', 'Secuencias'], ['campaigns', 'Campañas'], ['settings', 'Horario y ajustes']];

async function viewAutomation(root, tab, id) {
  root.append(
    h('h1', {}, 'Automatización'),
    h('div', { class: 'tabs' }, AUTO_TABS.map(([k, l]) => h('a', { href: `#/automation/${k}`, class: k === tab ? 'active' : '' }, l))),
  );
  if (needAccount(root)) return;
  const body = h('div');
  root.append(body);
  if (tab === 'rules') return id ? editRule(body, id) : listRules(body);
  if (tab === 'sequences') return id ? editSequence(body, id) : listSequences(body);
  if (tab === 'campaigns') return id ? editCampaign(body, id) : listCampaigns(body);
  if (tab === 'settings') return editSettings(body);
}

/** Datos de apoyo para los editores: chatbots, imágenes, secuencias, usuarios y servicios de la cuenta. */
async function automationRefs() {
  const [bots, sequences, users, services] = await Promise.all([
    api('GET', withAcct('/api/chatbots')),
    api('GET', withAcct('/api/sequences')),
    api('GET', withAcct('/api/users')),
    api('GET', withAcct('/api/services')),
  ]);
  const images = [];
  for (const b of bots) for (const img of await api('GET', `/api/chatbots/${b.id}/images`)) images.push({ ...img, bot: b.name });
  return { bots, sequences, users: users.filter((u) => u.account_id), services, images };
}

const TRIGGERS = {
  message_received: 'El cliente escribe un mensaje',
  new_contact: 'Primer mensaje de un cliente nuevo',
  intent: 'La IA detecta una intención',
  data_captured: 'Se guarda un dato del cliente',
  tag_added: 'Se agrega una etiqueta',
  no_reply: 'El cliente no responde en cierto tiempo',
  handoff: 'La conversación pasa a una persona',
  appointment_booked: 'Se agenda una cita o llamada',
  appointment_cancelled: 'Se cancela una cita o llamada',
  opt_out: 'El cliente se da de baja',
  goal_completed: 'Se cumple el objetivo de la conversación',
};
const ACTIONS = {
  send_message: 'Enviar mensaje',
  alert_team: 'Alertar al equipo',
  add_tag: 'Agregar etiqueta',
  remove_tag: 'Quitar etiqueta',
  set_field: 'Guardar un dato',
  handoff: 'Pasar a una persona',
  resume_bot: 'Devolver al bot',
  close_conversation: 'Cerrar conversación',
  start_sequence: 'Iniciar secuencia',
  stop_sequences: 'Detener secuencias',
  webhook: 'Enviar a otro sistema (webhook)',
};
const CONDITIONS = {
  channel: 'Canal',
  business_hours: 'Horario del negocio',
  has_tag: 'Etiqueta',
  field: 'Dato del cliente',
  status: 'Estado de la conversación',
};

/** Plantillas para empezar rápido: cubren las necesidades más comunes. */
const RULE_TEMPLATES = [
  { name: 'Bienvenida a clientes nuevos', trigger: { type: 'new_contact' }, actions: [{ type: 'add_tag', tag: 'nuevo' }] },
  { name: 'Fuera de horario', trigger: { type: 'message_received', match: 'any' }, conditions: [{ type: 'business_hours', inside: false }], actions: [{ type: 'send_message', text: 'Gracias por escribir 🙌 Estamos fuera de horario; te respondemos en cuanto abramos.' }] },
  { name: 'Palabra urgente → alerta', trigger: { type: 'message_received', match: 'keywords', keywords: ['urgente', 'emergencia'] }, actions: [{ type: 'alert_team', message: '🚨 {{cliente}} escribió algo urgente: "{{mensaje}}"' }, { type: 'handoff', reason: 'Mensaje urgente' }] },
  { name: 'Seguimiento si no responde', trigger: { type: 'no_reply', minutes: 120 }, conditions: [{ type: 'status', status: 'bot' }], actions: [{ type: 'send_message', text: '¿Pudiste revisarlo, {{nombre}}? Si tienes alguna duda, aquí estoy.' }] },
  { name: 'Queja → persona', trigger: { type: 'intent', intent: 'queja', description: 'El cliente está molesto, inconforme o reporta un problema' }, actions: [{ type: 'handoff', reason: 'Queja del cliente' }, { type: 'alert_team', message: 'Queja de {{cliente}}: "{{mensaje}}"' }] },
  { name: 'Quiere comprar → avisar a ventas', trigger: { type: 'intent', intent: 'listo_para_comprar', description: 'El cliente quiere comprar, reservar o pagar' }, actions: [{ type: 'add_tag', tag: 'caliente' }, { type: 'alert_team', message: '{{cliente}} está listo para comprar. {{link}}' }] },
  { name: 'Correo capturado → CRM', trigger: { type: 'data_captured', field: 'correo' }, actions: [{ type: 'webhook', url: 'https://mi-crm.com/webhook' }] },
  { name: 'Agradecer cita agendada', trigger: { type: 'appointment_booked' }, actions: [{ type: 'send_message', text: 'Te esperamos el {{cita.fecha}} a las {{cita.hora}} 🙌', delay_minutes: 1 }] },
];

function triggerSummary(t) {
  switch (t.type) {
    case 'message_received':
      return t.match === 'any' ? 'Cualquier mensaje' : `Mensaje ${t.match === 'exact' ? 'igual a' : 'con'}: ${t.keywords.join(', ')}`;
    case 'intent': return `Intención: ${t.intent}`;
    case 'no_reply': return `Sin respuesta en ${t.minutes >= 60 ? `${Math.round(t.minutes / 60 * 10) / 10} h` : `${t.minutes} min`}`;
    case 'data_captured': return `Dato guardado${t.field ? `: ${t.field}` : ''}`;
    case 'tag_added': return `Etiqueta: ${t.tag}`;
    default: return TRIGGERS[t.type];
  }
}

async function listRules(root) {
  const rules = await api('GET', withAcct('/api/automations'));
  const create = async (tpl) => {
    const r = await run(() => api('POST', '/api/automations', { ...tpl, active: false, account_id: state.accountId || undefined }), 'Regla creada (desactivada): revísala y actívala');
    if (r) location.hash = `#/automation/rules/${r.id}`;
  };
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Una regla dice: ', h('strong', {}, 'cuando pase algo'), ', ', h('strong', {}, 'si se cumplen ciertas condiciones'), ', ', h('strong', {}, 'haz estas acciones'), '. Funcionan en todos los canales y junto con la IA.'),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/automation/rules/new' }, '+ Regla en blanco')),
      h('h3', {}, 'Plantillas rápidas'),
      h('div', { class: 'row' }, RULE_TEMPLATES.map((t) => h('button', { class: 'small', onclick: () => create(t) }, t.name)))),
    h('div', { class: 'card' },
      rules.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Regla'), h('th', {}, 'Cuando'), h('th', {}, 'Acciones'), h('th', {}, 'Veces'), h('th', {}, ''))),
            h('tbody', {}, rules.map((r) => h('tr', {},
              h('td', {}, h('a', { href: `#/automation/rules/${r.id}` }, h('strong', {}, r.name)), ' ', r.active ? null : h('span', { class: 'badge orange' }, 'inactiva'), r.stop_ai ? h('div', { class: 'small muted' }, 'la IA no responde') : null),
              h('td', { class: 'small' }, triggerSummary(r.trigger), r.conditions.length ? h('div', { class: 'muted' }, `+ ${r.conditions.length} condición(es)`) : null),
              h('td', { class: 'small' }, r.actions.map((a) => ACTIONS[a.type]).join(' → ')),
              h('td', { class: 'small muted' }, r.run_count, r.last_run_at ? h('div', {}, fmtDate(r.last_run_at)) : null),
              h('td', {}, h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/automations/${r.id}`, { active: !r.active }), r.active ? 'Desactivada' : 'Activada')) render(); } }, r.active ? 'Desactivar' : 'Activar'))))))
        : h('p', { class: 'muted' }, 'Aún no hay reglas. Empieza con una plantilla.')),
  );
}

/** Editor de una lista de elementos con tipo (condiciones o acciones). */
function typedList(list, types, fieldsFor, onChange) {
  const box = h('div');
  const draw = () => {
    fill(box,
      ...list.map((item, i) => h('div', { class: 'list-item' },
        h('div', { class: 'row between' },
          h('strong', {}, `${i + 1}. ${types[item.type]}`),
          h('div', { class: 'row' },
            h('button', { class: 'small', disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }, '↑'),
            h('button', { class: 'small danger', onclick: () => { list.splice(i, 1); draw(); onChange?.(); } }, 'Quitar'))),
        fieldsFor(item, draw))),
      h('div', { class: 'row' },
        h('select', { onchange: (e) => { if (e.target.value) { list.push({ type: e.target.value }); e.target.value = ''; draw(); onChange?.(); } } },
          h('option', { value: '' }, '+ Agregar…'),
          Object.entries(types).map(([k, l]) => h('option', { value: k }, l)))));
  };
  draw();
  return box;
}

const VARS_HELP = 'Variables: {{nombre}}, {{cliente}}, {{telefono}}, {{negocio}}, {{mensaje}}, {{link}}, {{dato.CAMPO}}, {{cita.servicio}}, {{cita.fecha}}, {{cita.hora}}, {{cita.lugar}}';

function actionFields(a, refs) {
  switch (a.type) {
    case 'send_message':
      a.text ??= ''; a.image_id ??= ''; a.delay_minutes ??= 0;
      return [
        field('Mensaje', area(a, 'text'), VARS_HELP),
        h('div', { class: 'grid' },
          field('Imagen (opcional)', select(a, 'image_id', [['', '— Sin imagen —'], ...refs.images.map((i) => [i.id, `${i.name} (${i.bot})`])])),
          field('Esperar antes de enviar (minutos)', num(a, 'delay_minutes', { min: 0 }), '0 = de inmediato')),
      ];
    case 'alert_team':
      a.message ??= '{{cliente}} necesita atención: "{{mensaje}}"'; a.roles ??= ['admin', 'agent']; a.user_ids ??= []; a.phones ??= [];
      return [
        field('Mensaje de la alerta', area(a, 'message'), VARS_HELP),
        h('p', { class: 'small muted', style: 'margin:0 0 6px' }, 'Destinatarios (si eliges personas, solo a ellas; si no, por rol):'),
        h('div', { class: 'row' }, refs.users.map((u) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.user_ids.includes(u.id), onchange: (e) => { a.user_ids = e.target.checked ? [...a.user_ids, u.id] : a.user_ids.filter((x) => x !== u.id); } }),
          u.name || u.email, u.notify_whatsapp && u.phone ? ' 📱' : ''))),
        h('div', { class: 'row' }, [['admin', 'Administradores'], ['agent', 'Agentes']].map(([r, l]) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: a.roles.includes(r), onchange: (e) => { a.roles = e.target.checked ? [...a.roles, r] : a.roles.filter((x) => x !== r); } }), l))),
        field('Además, avisar por WhatsApp a estos números', lines(a, 'phones', { placeholder: '5215512345678' }), '📱 = recibe también por WhatsApp (configurable en Usuarios).'),
      ];
    case 'add_tag':
    case 'remove_tag':
      a.tag ??= '';
      return [field('Etiqueta', text(a, 'tag', { placeholder: 'interesado' }))];
    case 'set_field':
      a.field ??= ''; a.value ??= '';
      return [h('div', { class: 'grid' }, field('Clave del dato', text(a, 'field', { placeholder: 'origen' })), field('Valor', text(a, 'value', { placeholder: 'campaña octubre' })))];
    case 'handoff':
      a.reason ??= 'Regla automática';
      return [field('Motivo', text(a, 'reason'))];
    case 'start_sequence':
      a.sequence_id ??= refs.sequences[0]?.id || '';
      return [refs.sequences.length ? field('Secuencia', select(a, 'sequence_id', refs.sequences.map((s) => [s.id, s.name]))) : h('p', { class: 'muted' }, 'Primero crea una secuencia.')];
    case 'webhook':
      a.url ??= '';
      return [field('URL', text(a, 'url', { placeholder: 'https://hook.n8n.io/…' }), 'Se envía un POST con los datos del cliente, firmado con la cabecera X-Signature (clave en Horario y ajustes).')];
    default:
      return [];
  }
}

function conditionFields(c) {
  switch (c.type) {
    case 'channel':
      c.channel_types ??= [];
      return [h('div', { class: 'row' }, state.meta.channel_types.map((t) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: c.channel_types.includes(t.type), onchange: (e) => { c.channel_types = e.target.checked ? [...c.channel_types, t.type] : c.channel_types.filter((x) => x !== t.type); } }), t.label)))];
    case 'business_hours':
      c.inside ??= true;
      return [h('select', { onchange: (e) => (c.inside = e.target.value === 'true') },
        [['true', 'Dentro del horario'], ['false', 'Fuera del horario']].map(([v, l]) => h('option', { value: v, selected: String(c.inside) === v }, l)))];
    case 'has_tag':
      c.tag ??= ''; c.negate ??= false;
      return [h('div', { class: 'grid' }, field('Etiqueta', text(c, 'tag')), check(c, 'negate', 'NO la tiene'))];
    case 'field':
      c.field ??= ''; c.op ??= 'present'; c.value ??= '';
      return [h('div', { class: 'grid' }, field('Dato', text(c, 'field', { placeholder: 'correo' })),
        field('Condición', select(c, 'op', [['present', 'tiene valor'], ['absent', 'está vacío'], ['equals', 'es igual a'], ['contains', 'contiene']])),
        field('Valor', text(c, 'value')))];
    case 'status':
      c.status ??= 'bot';
      return [select(c, 'status', [['bot', 'La atiende el bot'], ['human', 'La atiende una persona'], ['closed', 'Cerrada']])];
    default:
      return [];
  }
}

async function editRule(root, id) {
  const refs = await automationRefs();
  const existing = id === 'new' ? null : (await api('GET', withAcct('/api/automations'))).find((r) => r.id === id);
  if (id !== 'new' && !existing) throw new Error('Regla no encontrada');
  const r = existing ? clone(existing) : { name: '', active: true, chatbot_id: null, stop_ai: false, priority: 0, trigger: { type: 'message_received', match: 'keywords', keywords: [] }, conditions: [], actions: [] };
  r.chatbot_id ??= '';
  const trigBox = h('div');
  const drawTrigger = () => {
    const t = r.trigger;
    const f = [];
    if (t.type === 'message_received') {
      t.match ??= 'keywords'; t.keywords ??= []; t.first_message_only ??= false;
      f.push(field('Coincidencia', select(t, 'match', [['keywords', 'Contiene alguna de estas palabras o frases'], ['exact', 'Es exactamente una de ellas'], ['contains', 'Contiene el texto (en cualquier parte)'], ['any', 'Cualquier mensaje']], drawTrigger)));
      if (t.match !== 'any') f.push(field('Palabras o frases', lines(t, 'keywords', { placeholder: 'precio\nlista de precios\ncuánto cuesta' }), 'Una por renglón. No distingue mayúsculas ni acentos.'));
      f.push(check(t, 'first_message_only', 'Solo en el primer mensaje del cliente'));
    } else if (t.type === 'intent') {
      t.intent ??= ''; t.description ??= '';
      f.push(h('div', { class: 'grid' }, field('Identificador', text(t, 'intent', { placeholder: 'quiere_cotizar' })), field('Descripción para la IA', text(t, 'description', { placeholder: 'El cliente pide precio o cotización de un servicio' }))));
    } else if (t.type === 'data_captured') {
      t.field ??= '';
      f.push(field('Dato (vacío = cualquiera)', text(t, 'field', { placeholder: 'correo' })));
    } else if (t.type === 'tag_added') {
      t.tag ??= '';
      f.push(field('Etiqueta', text(t, 'tag')));
    } else if (t.type === 'no_reply') {
      t.minutes ??= 60;
      f.push(field('Minutos sin respuesta del cliente (después de nuestro último mensaje)', num(t, 'minutes', { min: 1 }), '60 = 1 hora · 1440 = 1 día. Se envía una sola vez por cada silencio.'));
    } else if (t.type === 'appointment_booked' || t.type === 'appointment_cancelled') {
      t.service_id ??= '';
      f.push(field('Servicio', select(t, 'service_id', [['', 'Cualquiera'], ...refs.services.map((s) => [s.id, s.name])])));
    }
    fill(trigBox, field('Cuando…', select(r.trigger, 'type', Object.entries(TRIGGERS), (v) => { r.trigger = { type: v }; drawTrigger(); })), ...f);
  };
  drawTrigger();
  const save = async () => {
    const body = { ...r, chatbot_id: r.chatbot_id || null, account_id: state.accountId || undefined };
    const saved = await run(() => (existing ? api('PUT', `/api/automations/${id}`, body) : api('POST', '/api/automations', body)), 'Regla guardada ✅');
    if (saved) location.hash = '#/automation/rules';
  };
  root.append(
    h('a', { href: '#/automation/rules' }, '← Reglas'),
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre de la regla', text(r, 'name', { placeholder: 'Alerta de quejas' })),
        field('Aplica a', select(r, 'chatbot_id', [['', 'Todos los chatbots de la cuenta'], ...refs.bots.map((b) => [b.id, b.name])]))),
      check(r, 'active', 'Activa'),
      check(r, 'stop_ai', 'Si se cumple, la IA no responde ese mensaje (la regla se encarga)')),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '1. Cuándo'), trigBox),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '2. Solo si… (opcional)'), typedList(r.conditions, CONDITIONS, (c) => conditionFields(c))),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '3. Hacer'), typedList(r.actions, ACTIONS, (a) => actionFields(a, refs))),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Eliminar la regla?')) { await run(() => api('DELETE', `/api/automations/${id}`), 'Eliminada'); location.hash = '#/automation/rules'; } } }, 'Eliminar')) : null),
  );
}

/* ------------------------------ Secuencias ------------------------------ */

const UNITS = [['minutes', 'minutos'], ['hours', 'horas'], ['days', 'días']];

async function listSequences(root) {
  const seqs = await api('GET', withAcct('/api/sequences'));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Una secuencia es una serie de mensajes programados (por ejemplo: hoy, en 2 días y en una semana). Se inicia con una regla o desde una conversación, respeta el horario del negocio y se detiene si el cliente responde.'),
      h('a', { class: 'btn primary', href: '#/automation/sequences/new' }, '+ Nueva secuencia')),
    h('div', { class: 'card' },
      seqs.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Secuencia'), h('th', {}, 'Pasos'), h('th', {}, 'En curso'), h('th', {}, 'Completadas'), h('th', {}, 'Detenidas'))),
            h('tbody', {}, seqs.map((q) => h('tr', { class: 'click', onclick: () => (location.hash = `#/automation/sequences/${q.id}`) },
              h('td', {}, h('strong', {}, q.name), q.active ? null : h('span', { class: 'badge orange' }, ' inactiva')),
              h('td', {}, q.steps.length),
              h('td', {}, q.enrollments.active ?? 0), h('td', {}, q.enrollments.completed ?? 0), h('td', {}, q.enrollments.stopped ?? 0)))))
        : h('p', { class: 'muted' }, 'Aún no hay secuencias.')),
  );
}

async function editSequence(root, id) {
  const refs = await automationRefs();
  const existing = id === 'new' ? null : refs.sequences.find((q) => q.id === id);
  if (id !== 'new' && !existing) throw new Error('Secuencia no encontrada');
  const q = existing ? clone(existing) : { name: '', active: true, stop_on_reply: true, business_hours_only: true, steps: [{ delay_value: 0, delay_unit: 'minutes', at_time: '', text: '', image_id: '', conditions: [] }] };
  const list = h('div');
  const draw = () => fill(list, ...q.steps.map((st, i) => h('div', { class: 'list-item' },
    h('div', { class: 'row between' }, h('strong', {}, `Mensaje ${i + 1}`),
      h('div', { class: 'row' },
        h('button', { class: 'small', disabled: i === 0, onclick: () => { [q.steps[i - 1], q.steps[i]] = [q.steps[i], q.steps[i - 1]]; draw(); } }, '↑'),
        h('button', { class: 'small danger', disabled: q.steps.length === 1, onclick: () => { q.steps.splice(i, 1); draw(); } }, 'Quitar'))),
    h('div', { class: 'grid' },
      field(i === 0 ? 'Esperar desde que inicia' : 'Esperar desde el mensaje anterior', h('div', { class: 'row' }, h('div', { style: 'width:90px' }, num(st, 'delay_value', { min: 0 })), select(st, 'delay_unit', UNITS))),
      field('A esta hora (opcional)', h('input', { type: 'time', value: st.at_time, oninput: (e) => (st.at_time = e.target.value) }), 'Ej.: al día siguiente a las 10:00')),
    field('Mensaje', area(st, 'text'), VARS_HELP),
    field('Imagen (opcional)', select(st, 'image_id', [['', '— Sin imagen —'], ...refs.images.map((im) => [im.id, `${im.name} (${im.bot})`])])),
    h('details', {}, h('summary', {}, `Enviar solo si… (${st.conditions.length})`), typedList(st.conditions, CONDITIONS, (c) => conditionFields(c))))));
  draw();
  const save = async () => {
    const saved = await run(() => (existing ? api('PUT', `/api/sequences/${id}`, q) : api('POST', '/api/sequences', { ...q, account_id: state.accountId || undefined })), 'Secuencia guardada ✅');
    if (saved) location.hash = '#/automation/sequences';
  };
  root.append(
    h('a', { href: '#/automation/sequences' }, '← Secuencias'),
    h('div', { class: 'card' },
      field('Nombre', text(q, 'name', { placeholder: 'Seguimiento de cotización' })),
      check(q, 'active', 'Activa'),
      check(q, 'stop_on_reply', 'Detener si el cliente responde'),
      check(q, 'business_hours_only', 'Enviar solo en horario del negocio (lo que caiga fuera se pasa a la siguiente apertura)')),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Mensajes'), list,
      h('button', { onclick: () => { q.steps.push({ delay_value: 1, delay_unit: 'days', at_time: '', text: '', image_id: '', conditions: [] }); draw(); } }, '+ Agregar mensaje')),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Eliminar la secuencia? Se detendrá para todos los inscritos.')) { await run(() => api('DELETE', `/api/sequences/${id}`), 'Eliminada'); location.hash = '#/automation/sequences'; } } }, 'Eliminar')) : null),
  );
}

/* ------------------------------ Campañas ------------------------------ */

const CAMPAIGN_STATUS = { draft: ['', 'Borrador'], scheduled: ['orange', 'Programada'], sending: ['orange', 'Enviando'], sent: ['green', 'Enviada'], cancelled: ['red', 'Cancelada'] };

async function listCampaigns(root) {
  const [camps, channels] = await Promise.all([api('GET', withAcct('/api/campaigns')), api('GET', withAcct('/api/channels'))]);
  const chName = Object.fromEntries(channels.map((c) => [c.id, c.name]));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Envía un mensaje a un grupo de clientes (por etiqueta o actividad reciente), ahora o en una fecha. Nunca se envía a quien se dio de baja, y los envíos van espaciados para proteger tu número.'),
      h('a', { class: 'btn primary', href: '#/automation/campaigns/new' }, '+ Nueva campaña')),
    h('div', { class: 'card' },
      camps.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Campaña'), h('th', {}, 'Canal'), h('th', {}, 'Estado'), h('th', {}, 'Enviados'), h('th', {}, 'Omitidos'), h('th', {}, 'Fecha'))),
            h('tbody', {}, camps.map((c) => {
              const [cls, label] = CAMPAIGN_STATUS[c.status];
              return h('tr', { class: 'click', onclick: () => (location.hash = `#/automation/campaigns/${c.id}`) },
                h('td', {}, h('strong', {}, c.name)), h('td', {}, chName[c.channel_id] || ''),
                h('td', {}, h('span', { class: `badge ${cls}` }, label)),
                h('td', {}, c.stats.sent ?? 0), h('td', {}, c.stats.skipped ?? 0),
                h('td', { class: 'small muted' }, c.scheduled_at ? fmtDate(c.scheduled_at) : ''));
            })))
        : h('p', { class: 'muted' }, 'Aún no hay campañas.')),
  );
}

async function editCampaign(root, id) {
  const [refs, channels] = await Promise.all([automationRefs(), api('GET', withAcct('/api/channels'))]);
  const existing = id === 'new' ? null : (await api('GET', withAcct('/api/campaigns'))).find((c) => c.id === id);
  if (id !== 'new' && !existing) throw new Error('Campaña no encontrada');
  const c = existing ? clone(existing) : { name: '', channel_id: channels[0]?.id || '', message: '', image_id: null, audience: { tags_any: [], tags_none: [], active_within_days: 0, statuses: [] }, scheduled_at: null, rate_per_minute: 20, business_hours_only: true, status: 'draft' };
  c.image_id ??= '';
  const editable = ['draft', 'scheduled'].includes(c.status);
  const local = { when: c.scheduled_at ? new Date(new Date(c.scheduled_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' };
  const previewBox = h('div');
  const body = () => ({ ...c, image_id: c.image_id || null, scheduled_at: local.when ? new Date(local.when).toISOString() : null, account_id: state.accountId || undefined });
  const save = async () => {
    const saved = await run(() => (existing ? api('PUT', `/api/campaigns/${id}`, body()) : api('POST', '/api/campaigns', body())), 'Campaña guardada');
    if (saved && !existing) location.hash = `#/automation/campaigns/${saved.id}`;
    return saved;
  };
  const statusBox = h('div');
  if (existing) {
    const [cls, label] = CAMPAIGN_STATUS[c.status];
    const recipients = await api('GET', `/api/campaigns/${id}/recipients`);
    fill(statusBox, h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Estado: ', h('span', { class: `badge ${cls}` }, label)),
        h('div', { class: 'row' },
          editable ? h('button', { class: 'small', onclick: async () => { const p = await run(() => api('POST', `/api/campaigns/${id}/preview`)); if (p) fill(previewBox, h('p', {}, h('strong', {}, `${p.count} destinatarios`), p.sample.length ? `: ${p.sample.join(', ')}${p.count > p.sample.length ? '…' : ''}` : ''), p.warning ? h('p', { class: 'badge orange' }, p.warning) : null); } }, 'Ver destinatarios') : null,
          editable ? h('button', { class: 'primary small', onclick: async () => { if (!(await save())) return; if (!confirm(local.when ? 'Se programará el envío. ¿Continuar?' : 'Se enviará AHORA a todos los destinatarios. ¿Continuar?')) return; if (await run(() => api('POST', `/api/campaigns/${id}/launch`), 'Campaña en marcha')) render(); } }, local.when ? 'Programar envío' : 'Enviar ahora') : null,
          ['scheduled', 'sending'].includes(c.status) ? h('button', { class: 'small danger', onclick: async () => { if (confirm('¿Cancelar la campaña?')) { await run(() => api('POST', `/api/campaigns/${id}/cancel`), 'Cancelada'); render(); } } }, 'Cancelar') : null)),
      previewBox,
      recipients.length ? h('details', {}, h('summary', {}, `Destinatarios (${recipients.length}) · ${c.stats.sent ?? 0} enviados · ${c.stats.skipped ?? 0} omitidos`),
        h('table', {}, h('tbody', {}, recipients.map((r) => h('tr', {}, h('td', {}, r.name || r.push_name || (r.phone ? `+${r.phone}` : '—')), h('td', {}, r.status), h('td', { class: 'small muted' }, r.reason)))))) : null));
  }
  root.append(
    h('a', { href: '#/automation/campaigns' }, '← Campañas'),
    statusBox,
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre', text(c, 'name', { placeholder: 'Promoción de octubre' })),
        field('Canal', select(c, 'channel_id', channels.map((ch) => [ch.id, `${ch.name} (${ch.label})`])))),
      field('Mensaje', area(c, 'message', { big: true }), VARS_HELP),
      field('Imagen (opcional)', select(c, 'image_id', [['', '— Sin imagen —'], ...refs.images.map((im) => [im.id, `${im.name} (${im.bot})`])]))),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'A quién'),
      h('div', { class: 'grid' },
        field('Con alguna de estas etiquetas', lines(c.audience, 'tags_any', { placeholder: 'interesado\nvip' }), 'Vacío = todos'),
        field('Sin estas etiquetas', lines(c.audience, 'tags_none', { placeholder: 'ya_compro' })),
        field('Que escribieron en los últimos (días)', num(c.audience, 'active_within_days', { min: 0 }), '0 = sin límite')),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Cuándo y a qué ritmo'),
      h('div', { class: 'grid' },
        field('Fecha y hora de envío', h('input', { type: 'datetime-local', value: local.when, oninput: (e) => (local.when = e.target.value) }), 'Vacío = al pulsar "Enviar ahora"'),
        field('Mensajes por minuto', num(c, 'rate_per_minute', { min: 1, max: 120 }), 'Recomendado para WhatsApp: 10–30')),
      check(c, 'business_hours_only', 'Enviar solo en horario de atención (lo que no alcance sale en la siguiente apertura)'),
      h('p', { class: 'small muted' }, 'No se envía a quien se dio de baja ni a conversaciones que está atendiendo una persona.')),
    editable ? saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Eliminar la campaña?')) { await run(() => api('DELETE', `/api/campaigns/${id}`), 'Eliminada'); location.hash = '#/automation/campaigns'; } } }, 'Eliminar')) : null) : null,
  );
}

/* ------------------------------ Horario y ajustes ------------------------------ */

const DAY_NAMES = { mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo' };

/** Editor de horario semanal: "09:00-14:00, 16:00-19:00" por día. */
function hoursEditor(hours) {
  const toText = (list) => (list || []).map(([a, b]) => `${a}-${b}`).join(', ');
  return h('div', { class: 'grid' }, Object.entries(DAY_NAMES).map(([d, label]) =>
    field(label, h('input', {
      type: 'text', value: toText(hours[d]), placeholder: 'Cerrado',
      oninput: (e) => {
        hours[d] = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('-').map((y) => y.trim().padStart(5, '0')));
      },
    }))));
}

async function editSettings(root) {
  const s = await api('GET', withAcct('/api/settings'));
  const copy = (v) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(v); toast('Copiado'); } catch { toast('No se pudo copiar', true); } } }, 'Copiar');
  root.append(
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Horario del negocio'),
      h('p', { class: 'small muted' }, 'Formato por día: 09:00-14:00, 16:00-19:00 (vacío = cerrado). Lo usan el asistente (para responder "¿están abiertos?"), la agenda, las secuencias, las campañas y la condición "horario del negocio".'),
      field('Zona horaria', text(s, 'timezone')),
      hoursEditor(s.business_hours),
      field('Días cerrados (festivos)', lines(s, 'holidays', { placeholder: '2026-12-25\n2027-01-01' }), 'Formato AAAA-MM-DD, uno por renglón.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Bajas (dejar de recibir mensajes)'),
      check(s.opt_out, 'enabled', 'Permitir que el cliente se dé de baja escribiendo una palabra'),
      h('div', { class: 'grid' },
        field('Palabras para darse de baja', lines(s.opt_out, 'keywords'), 'El mensaje debe ser exactamente una de ellas.'),
        field('Palabras para volver a recibir', lines(s.opt_out, 'resume_keywords'))),
      field('Respuesta al darse de baja', area(s.opt_out, 'confirm_message')),
      field('Respuesta al volver', area(s.opt_out, 'resume_message')),
      h('p', { class: 'small muted' }, 'Quien se da de baja no recibe campañas, secuencias ni mensajes de reglas; sí recibe recordatorios de sus citas.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Equipo'),
      check(s, 'notify_team_on_handoff', 'Avisar en el panel a todo el equipo cuando una conversación pasa a una persona')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Integraciones'),
      h('p', {}, 'Calendario de citas para Google Calendar / Outlook / Apple (suscribirse por URL):'),
      h('p', {}, h('code', {}, s.ics_url), ' ', copy(s.ics_url)),
      h('p', {}, 'Clave para verificar los webhooks salientes (cabecera ', h('code', {}, 'X-Signature: sha256=HMAC'), '):'),
      h('p', {}, h('code', {}, s.webhook_secret), ' ', copy(s.webhook_secret)),
      h('button', { class: 'small', onclick: async () => { if (confirm('Se generarán nuevas URL y claves; las anteriores dejarán de funcionar.')) { await run(() => api('POST', withAcct('/api/settings/rotate-secrets')), 'Claves regeneradas'); render(); } } }, 'Regenerar URL y claves')),
    saveBar(async () => {
      const { ics_url, ...body } = s;
      void ics_url;
      if (await run(() => api('PUT', withAcct('/api/settings'), body), 'Guardado ✅')) render();
    }),
  );
}

/* ============================== Agenda ============================== */

const APPT_STATUS = { confirmed: ['green', 'Confirmada'], completed: ['', 'Completada'], no_show: ['orange', 'No asistió'], cancelled: ['red', 'Cancelada'] };

async function viewAgenda(root, tab, params) {
  root.append(
    h('h1', {}, 'Agenda'),
    h('div', { class: 'tabs' }, [['citas', 'Citas y llamadas'], ...(isAdmin() ? [['servicios', 'Servicios']] : [])].map(([k, l]) => h('a', { href: `#/agenda/${k}`, class: k === tab ? 'active' : '' }, l))),
  );
  if (needAccount(root)) return;
  const body = h('div');
  root.append(body);
  if (tab === 'servicios') return params.get('id') ? editService(body, params.get('id')) : listServices(body);
  return agendaWeek(body, params);
}

/** Fecha AAAA-MM-DD en la zona horaria del negocio. */
const tzDate = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const capital = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const dayTitle = (iso) => capital(new Date(iso + 'T12:00:00Z').toLocaleDateString('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }));

async function agendaWeek(root, params) {
  const { timezone: tz } = await api('GET', withAcct('/api/agenda/info'));
  const today = tzDate(new Date(), tz);
  const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const monday = params.get('week') || addDaysIso(today, -dow);
  const days = [...Array(7)].map((_, i) => addDaysIso(monday, i));
  // Rango amplio en UTC; luego se agrupa por día en la hora del negocio.
  const from = new Date(monday + 'T00:00:00Z').getTime() - 86400000;
  const to = new Date(days[6] + 'T00:00:00Z').getTime() + 2 * 86400000;
  const [appts, services] = await Promise.all([
    api('GET', withAcct(`/api/appointments?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`)),
    api('GET', withAcct('/api/services')),
  ]);
  const go = (n) => (location.hash = `#/agenda/citas?week=${addDaysIso(monday, n)}`);
  const hhmm = (d) => new Date(d).toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

  // Nueva cita
  const n = { service_id: services.find((s) => s.active)?.id || '', slot: '', customer_name: '', customer_phone: '', notes: '' };
  const slotBox = h('div');
  const loadSlots = async () => {
    if (!n.service_id) return fill(slotBox, h('p', { class: 'muted' }, 'Crea un servicio primero.'));
    const slots = await api('GET', `/api/services/${n.service_id}/slots`);
    n.slot = slots[0]?.key || '';
    fill(slotBox, slots.length ? field('Horario disponible', select(n, 'slot', slots.map((x) => [x.key, x.label]))) : h('p', { class: 'muted' }, 'Sin horarios disponibles.'));
  };
  const createBox = h('div', { class: 'card', hidden: true },
    h('h3', { style: 'margin-top:0' }, 'Nueva cita o llamada'),
    field('Servicio', select(n, 'service_id', services.filter((s) => s.active).map((s) => [s.id, `${s.name} (${s.kind === 'call' ? 'llamada' : 'cita'})`]), loadSlots)),
    slotBox,
    h('div', { class: 'grid' }, field('Nombre del cliente', text(n, 'customer_name')), field('Teléfono', text(n, 'customer_phone', { placeholder: '5215512345678' }))),
    field('Notas', area(n, 'notes')),
    h('p', { class: 'small muted' }, 'Para avisar al cliente por su chat, agenda desde su conversación.'),
    h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', '/api/appointments', n), 'Agendada ✅')) render(); } }, 'Agendar'));

  const byDay = new Map(days.map((d) => [d, []]));
  for (const a of appts) {
    const k = tzDate(a.starts_at, tz);
    if (byDay.has(k)) byDay.get(k).push(a);
  }
  const action = (a, label, fn, cls = 'small') => h('button', { class: cls, onclick: async () => { if (await run(fn, 'Listo')) render(); } }, label);
  root.append(
    h('div', { class: 'card row between' },
      h('div', { class: 'row' }, h('button', { onclick: () => go(-7) }, '← Semana anterior'), h('button', { onclick: () => (location.hash = '#/agenda/citas') }, 'Hoy'), h('button', { onclick: () => go(7) }, 'Semana siguiente →')),
      h('strong', {}, `${dayTitle(days[0])} – ${dayTitle(days[6])}`, h('span', { class: 'small muted' }, ` · hora de ${tz}`)),
      h('button', { class: 'primary', onclick: () => { createBox.hidden = !createBox.hidden; if (!createBox.hidden) loadSlots(); } }, '+ Nueva cita')),
    createBox,
    ...[...byDay].map(([day, list]) => h('div', { class: 'card' },
      h('h3', { style: 'margin:0 0 8px' }, dayTitle(day), day === today ? h('span', { class: 'badge green' }, ' hoy') : null),
      list.length ? h('table', {}, h('tbody', {}, list.map((a) => {
        const [cls, label] = APPT_STATUS[a.status];
        return h('tr', {},
          h('td', { style: 'width:70px' }, h('strong', {}, hhmm(a.starts_at))),
          h('td', {}, a.kind === 'call' ? '📞 ' : '📅 ', h('strong', {}, a.service_name), a.source === 'simulador' ? h('span', { class: 'badge' }, ' prueba') : null,
            h('div', { class: 'small muted' }, [a.customer_name || 'Cliente', a.customer_phone && `+${a.customer_phone.replace(/^\+/, '')}`, a.assigned_user_name && `atiende: ${a.assigned_user_name}`, a.notes].filter(Boolean).join(' · '))),
          h('td', {}, h('span', { class: `badge ${cls}` }, label)),
          h('td', {}, h('div', { class: 'row' },
            a.conversation_id ? h('a', { class: 'btn small', href: `#/conversation/${a.conversation_id}` }, 'Chat') : null,
            a.status === 'confirmed' ? action(a, 'Completada', () => api('PUT', `/api/appointments/${a.id}`, { status: 'completed' })) : null,
            a.status === 'confirmed' ? action(a, 'No asistió', () => api('PUT', `/api/appointments/${a.id}`, { status: 'no_show' })) : null,
            a.status === 'confirmed' ? h('button', { class: 'small', onclick: async () => {
              const slots = a.service_id ? await api('GET', `/api/services/${a.service_id}/slots`) : [];
              const pick = prompt(`Nuevo horario (AAAA-MM-DDTHH:MM). Disponibles:\n${slots.slice(0, 12).map((s) => `${s.key}  (${s.label})`).join('\n')}`, slots[0]?.key || '');
              if (pick && (await run(() => api('PUT', `/api/appointments/${a.id}`, { slot: pick.trim() }), 'Reprogramada'))) render();
            } }, 'Reprogramar') : null,
            a.status === 'confirmed' ? h('button', { class: 'small danger', onclick: async () => {
              const reason = prompt('Motivo de la cancelación (se avisará al cliente si tiene chat)', 'Cancelada por el negocio');
              if (reason !== null && (await run(() => api('POST', `/api/appointments/${a.id}/cancel`, { reason }), 'Cancelada'))) render();
            } }, 'Cancelar') : null)));
      }))) : h('p', { class: 'muted small', style: 'margin:0' }, 'Sin citas'))),
  );
}

async function listServices(root) {
  const services = await api('GET', withAcct('/api/services'));
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Los servicios son lo que se puede agendar (citas presenciales o llamadas). El bot ofrece solo horarios realmente libres, agenda cuando el cliente elige, envía recordatorios y avisa a quien atiende.'),
      h('a', { class: 'btn primary', href: '#/agenda/servicios?id=new' }, '+ Nuevo servicio')),
    h('div', { class: 'card' }, services.length
      ? h('table', {}, h('tbody', {}, services.map((s) => h('tr', { class: 'click', onclick: () => (location.hash = `#/agenda/servicios?id=${s.id}`) },
          h('td', {}, s.kind === 'call' ? '📞 ' : '📅 ', h('strong', {}, s.name), s.active ? null : h('span', { class: 'badge orange' }, ' inactivo')),
          h('td', { class: 'small' }, `${s.duration_minutes} min`, s.capacity > 1 ? ` · ${s.capacity} a la vez` : ''),
          h('td', { class: 'small muted' }, s.hours ? 'horario propio' : 'horario del negocio')))))
      : h('p', { class: 'muted' }, 'Aún no hay servicios.')),
  );
}

async function editService(root, id) {
  const [services, users] = await Promise.all([api('GET', withAcct('/api/services')), api('GET', withAcct('/api/users'))]);
  const existing = id === 'new' ? null : services.find((s) => s.id === id);
  if (id !== 'new' && !existing) throw new Error('Servicio no encontrado');
  const s = existing ? clone(existing) : { name: '', kind: 'appointment', description: '', duration_minutes: 30, buffer_minutes: 0, capacity: 1, min_notice_minutes: 60, max_days_ahead: 30, location: '', hours: null, reminders: [1440, 60], reminder_message: '', assigned_user_ids: [], notify_team: true, active: true };
  const own = { on: !!s.hours };
  const hoursBox = h('div');
  const drawHours = () => fill(hoursBox, own.on ? hoursEditor((s.hours ||= { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [], sun: [] })) : null);
  drawHours();
  const rem = { text: (s.reminders || []).join('\n') };
  const team = users.filter((u) => u.account_id);
  const save = async () => {
    const body = { ...s, hours: own.on ? s.hours : null, reminders: rem.text.split('\n').map((x) => Number(x.trim())).filter((x) => x > 0), account_id: state.accountId || undefined };
    if (await run(() => (existing ? api('PUT', `/api/services/${id}`, body) : api('POST', '/api/services', body)), 'Servicio guardado ✅')) location.hash = '#/agenda/servicios';
  };
  root.append(
    h('a', { href: '#/agenda/servicios' }, '← Servicios'),
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre', text(s, 'name', { placeholder: 'Consulta inicial' })),
        field('Tipo', select(s, 'kind', [['appointment', 'Cita'], ['call', 'Llamada']])),
        field('Duración (min)', num(s, 'duration_minutes', { min: 5 })),
        field('Descanso entre citas (min)', num(s, 'buffer_minutes', { min: 0 })),
        field('Clientes a la vez', num(s, 'capacity', { min: 1 })),
        field('Anticipación mínima (min)', num(s, 'min_notice_minutes', { min: 0 })),
        field('Agendar hasta (días)', num(s, 'max_days_ahead', { min: 1 }))),
      field('Descripción (para que el bot la explique)', area(s, 'description')),
      field('Lugar o indicaciones', text(s, 'location', { placeholder: 'Av. Reforma 123, piso 2 · o · Te llamamos a tu número' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: own.on, onchange: (e) => { own.on = e.target.checked; drawHours(); } }), 'Usar un horario distinto al del negocio'),
      hoursBox,
      check(s, 'active', 'Activo (el bot puede agendarlo)')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Quién atiende y avisos'),
      h('p', { class: 'small muted' }, 'Si eliges personas, solo se ofrecen horarios en los que al menos una esté libre, y la cita se asigna a ella.'),
      h('div', { class: 'row' }, team.map((u) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: s.assigned_user_ids.includes(u.id), onchange: (e) => { s.assigned_user_ids = e.target.checked ? [...s.assigned_user_ids, u.id] : s.assigned_user_ids.filter((x) => x !== u.id); } }),
        u.name || u.email))),
      check(s, 'notify_team', 'Avisar al equipo cuando se agenda o cancela'),
      field('Recordatorios al cliente (minutos antes)', h('textarea', { value: rem.text, oninput: (e) => (rem.text = e.target.value) }), '1440 = un día antes · 60 = una hora antes. Uno por renglón.'),
      field('Mensaje del recordatorio (opcional)', area(s, 'reminder_message', { placeholder: 'Hola {{nombre}}, te recordamos tu {{cita.tipo}} de {{cita.servicio}} el {{cita.fecha}} a las {{cita.hora}}.' }), VARS_HELP)),
    saveBar(save, existing ? h('span', { class: 'row', style: 'margin-left:auto' },
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Eliminar el servicio? Las citas existentes se conservan.')) { await run(() => api('DELETE', `/api/services/${id}`), 'Eliminado'); location.hash = '#/agenda/servicios'; } } }, 'Eliminar')) : null),
  );
}

/* ============================== Notificaciones ============================== */

async function viewNotifications(root) {
  const data = await api('GET', '/api/notifications?limit=100');
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Notificaciones'),
      data.unread ? h('button', { onclick: async () => { await run(() => api('POST', '/api/notifications/read', {})); render(); } }, 'Marcar todas como leídas') : null),
    h('div', { class: 'card' },
      data.items.length ? h('table', {}, h('tbody', {}, data.items.map((n) => h('tr', { class: n.link ? 'click' : '', onclick: async () => {
        if (!n.read_at) await api('POST', '/api/notifications/read', { ids: [n.id] });
        if (n.link) location.hash = n.link.replace(/^#/, '#');
        else render();
      } },
        h('td', { style: 'width:10px' }, n.read_at ? '' : h('span', { class: 'badge red' }, '•')),
        h('td', {}, h('strong', {}, n.title), h('div', { class: 'small muted pre' }, n.body)),
        h('td', { class: 'small muted' }, fmtDate(n.created_at))))))
        : h('p', { class: 'muted' }, state.me.user.account_id ? 'Sin notificaciones.' : 'Las notificaciones llegan a los usuarios de cada cuenta.')),
  );
  refreshBell();
}

/* ------------------------------ Primeros pasos (asistente de configuración) ------------------------------ */

const ONB_STEPS = [
  ['negocio', 'business', 'Tu negocio'],
  ['asistente', 'assistant', 'Tu asistente'],
  ['fotos', 'photos', 'Fotos'],
  ['prueba', 'test', 'Pruébalo'],
  ['whatsapp', 'whatsapp', 'WhatsApp'],
];
const TIMEZONES = [
  ['America/Mexico_City', 'México (Centro)'], ['America/Monterrey', 'México (Monterrey)'], ['America/Cancun', 'México (Cancún)'],
  ['America/Chihuahua', 'México (Chihuahua)'], ['America/Mazatlan', 'México (Pacífico)'], ['America/Tijuana', 'México (Tijuana)'],
  ['America/Bogota', 'Colombia'], ['America/Lima', 'Perú'], ['America/Santiago', 'Chile'], ['America/Argentina/Buenos_Aires', 'Argentina'],
  ['America/Guatemala', 'Guatemala / Centroamérica'], ['America/Panama', 'Panamá'], ['America/Caracas', 'Venezuela'],
  ['America/Santo_Domingo', 'República Dominicana'], ['America/New_York', 'EUA (Este)'], ['America/Chicago', 'EUA (Centro)'],
  ['America/Los_Angeles', 'EUA (Pacífico)'], ['Europe/Madrid', 'España'],
];

async function viewOnboarding(root, stepKey) {
  const ob = await api('GET', withAcct('/api/onboarding'));
  if (state.me.account && ob.complete && !state.me.account.onboarding?.done) state.me.account.onboarding = { ...state.me.account.onboarding, done: true };
  const firstPending = ONB_STEPS.find(([, k]) => !ob.steps[k]);
  const current = ONB_STEPS.find(([slug]) => slug === stepKey) || (ob.complete ? null : firstPending) || null;
  const go = (slug) => { location.hash = `#/inicio/${slug}`; };
  const next = (slug) => { const i = ONB_STEPS.findIndex(([s]) => s === slug); state.me = null; go(ONB_STEPS[i + 1]?.[0] || ''); };

  root.append(
    h('h1', {}, ob.complete ? '¡Tu asistente está listo! 🎉' : `Configura tu asistente`),
    h('ol', { class: 'steps' }, ONB_STEPS.map(([slug, k, label], i) =>
      h('li', { class: `${ob.steps[k] ? 'done' : ''} ${current?.[0] === slug ? 'current' : ''}` },
        h('a', { href: `#/inicio/${slug}` }, h('span', { class: 'num' }, ob.steps[k] ? '✓' : i + 1), label)))),
  );
  const box = h('div');
  root.append(box);
  if (!current) return onbDone(box, ob);
  const [slug] = current;
  if (slug === 'negocio') return onbBusiness(box, ob, () => next(slug));
  if (slug === 'asistente') return onbAssistant(box, ob, () => next(slug));
  if (!ob.chatbot_id) return box.append(h('div', { class: 'card' }, h('p', {}, 'Primero configura tu asistente.'), h('a', { class: 'btn primary', href: '#/inicio/asistente' }, 'Ir al paso 2')));
  const bot = await api('GET', `/api/chatbots/${ob.chatbot_id}`);
  if (slug === 'fotos') {
    box.append(h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Fotos de tus productos o instalaciones (opcional)'),
      h('p', { class: 'muted' }, 'El asistente solo envía fotos de este catálogo, y elige la correcta según lo que pregunte el cliente. Describe cada foto (qué es, precio si aplica) para que la use bien.')));
    const imgs = h('div');
    box.append(imgs, h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => { await run(() => api('POST', withAcct('/api/onboarding/step'), { step: 'photos' })); next(slug); } }, 'Continuar'),
      h('span', { class: 'muted small' }, 'Puedes agregar o cambiar fotos después en Chatbots → Imágenes.')));
    return tabImages(imgs, bot);
  }
  if (slug === 'prueba') {
    box.append(h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Pruébalo como si fueras un cliente'),
      h('p', { class: 'muted' }, 'Pregunta precios, horarios o pide algo que no esté en tu información: debe decir que lo confirma con el equipo en lugar de inventar. Si algo no te gusta, regresa al paso 2 y ajusta la información.')));
    const pg = h('div');
    box.append(pg, h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'primary', onclick: async () => { await run(() => api('POST', withAcct('/api/onboarding/step'), { step: 'test' })); next(slug); } }, 'Me gusta, continuar'),
      h('a', { class: 'btn', href: '#/inicio/asistente' }, 'Ajustar información')));
    return tabPlayground(pg, bot);
  }
  if (slug === 'whatsapp') return onbWhatsapp(box, ob, bot);
}

function onbBusiness(box, ob, done) {
  const f = { business_type: state.me.account?.business_type || 'otro', timezone: ob.business.timezone, business_hours: clone(ob.business.business_hours), alert_phone: ob.business.alert_phone };
  box.append(h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Datos de tu negocio'),
    h('div', { class: 'grid' },
      field('Tipo de negocio', select(f, 'business_type', ob.business_types.map((b) => [b.key, b.label])), 'Con esto preparamos a tu asistente: cómo atiende, qué datos pide y qué no debe decir.'),
      field('Zona horaria', select(f, 'timezone', TIMEZONES.some(([z]) => z === f.timezone) ? TIMEZONES : [[f.timezone, f.timezone], ...TIMEZONES])),
      field('Tu WhatsApp para avisos', text(f, 'alert_phone', { placeholder: '5215512345678' }), 'Con lada de país. Te avisamos ahí cuando un cliente pida hablar con una persona.')),
    h('h4', {}, 'Horario de atención'),
    h('p', { class: 'small muted' }, 'Por día: 09:00-14:00, 16:00-19:00 (vacío = cerrado). Se usa para agendar citas y para los mensajes fuera de horario.'),
    hoursEditor(f.business_hours),
    h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', withAcct('/api/onboarding/business'), f), 'Guardado')) done(); } }, 'Guardar y continuar')));
}

function onbAssistant(box, ob, done) {
  const a = ob.assistant || { assistant_name: '', formality: '', knowledge: {} };
  // Sin bot todavía, el trato lo decide la plantilla del giro (p.ej. "usted" en salud).
  const f = { assistant_name: a.assistant_name || '', formality: ob.assistant ? a.formality : '', description: '', knowledge: { catalog: '', hours: '', location: '', faq: '', other: '', ...a.knowledge } };
  const k = f.knowledge;
  box.append(h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Lo que tu asistente sabe'),
    h('p', { class: 'muted' }, 'Tu asistente responde únicamente con esta información: si un precio o dato no está aquí, dirá que lo confirma con tu equipo. Escribe como se lo explicarías a un empleado nuevo.'),
    h('div', { class: 'grid' },
      field('Nombre del asistente (opcional)', text(f, 'assistant_name', { placeholder: 'Sofi' })),
      field('Cómo trata a tus clientes', select(f, 'formality', [...(f.formality ? [] : [['', 'Lo usual en tu tipo de negocio']]), ['tu', 'De tú'], ['usted', 'De usted']]))),
    field('Describe tu negocio en una o dos frases', area(f, 'description', { placeholder: 'Clínica dental familiar en el centro de Monterrey, con 15 años de experiencia.' })),
    field('Productos o servicios con precios *', area(k, 'catalog', { big: true, placeholder: 'Limpieza dental — $600 (45 min)\nResina — desde $900\nBlanqueamiento — $3,500\nConsulta de valoración — gratis' }), 'Uno por renglón. Incluye precios, duración, tamaños o lo que te pregunten.'),
    h('div', { class: 'grid' },
      field('Detalles de horario (opcional)', area(k, 'hours', { placeholder: 'Último turno a las 18:30\nDías festivos cerramos' }), 'Tu horario de atención del paso 1 ya lo conoce; aquí van solo detalles extra.'),
      field('Ubicación y contacto', area(k, 'location', { placeholder: 'Av. Constitución 100, Centro, Monterrey\nEstacionamiento gratis\nTel. 81 1234 5678' }))),
    field('Preguntas frecuentes', area(k, 'faq', { big: true, placeholder: '¿Aceptan tarjeta? Sí, todas las tarjetas y transferencia.\n¿Hay estacionamiento? Sí, gratuito.' })),
    field('Otra información (promociones, políticas, formas de pago…)', area(k, 'other')),
    h('button', { class: 'primary', onclick: async () => {
      if (!k.catalog.trim()) return toast('Escribe al menos tus productos o servicios', true);
      if (await run(() => api('POST', withAcct('/api/onboarding/assistant'), { ...f, formality: f.formality || undefined }), 'Asistente listo')) done();
    } }, 'Guardar y continuar'),
    ob.chatbot_id ? h('p', { class: 'small muted' }, 'Para ajustes finos (personalidad, reglas, datos que pide, flujo) entra a ', h('a', { href: `#/bot/${ob.chatbot_id}/personalidad` }, 'la configuración avanzada'), '.') : null));
}

function onbWhatsapp(box, ob, bot) {
  if (!ob.email_verified) {
    return box.append(h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Confirma tu correo para conectar WhatsApp'),
      h('p', {}, `Te enviamos un enlace a ${state.me.user.email}. Ábrelo y vuelve aquí.`),
      h('div', { class: 'row' },
        h('button', { onclick: () => run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace') }, 'Reenviar correo'),
        h('button', { onclick: () => { state.me = null; render(); } }, 'Ya lo confirmé'))));
  }
  const status = h('div');
  const qrBox = h('div');
  let channelId = ob.whatsapp_channel_id;
  const showState = (st) => fill(status,
    st === 'open' ? h('div', { class: 'banner ok' }, '✅ WhatsApp conectado. Tu asistente ya responde a tus clientes.')
      : st === 'connecting' ? h('p', { class: 'muted' }, 'Esperando a que escanees el código…')
      : null);
  const poll = () => {
    clearTimers();
    state.timers.push(setInterval(async () => {
      if (!channelId) return;
      const st = await api('GET', `/api/channels/${channelId}/status`).catch(() => null);
      if (st?.state === 'open') { clearTimers(); fill(qrBox); showState('open'); state.me = null; setTimeout(() => { location.hash = '#/inicio'; render(); }, 1500); }
    }, 3000));
  };
  const connect = async () => {
    const ch = await run(() => api('POST', withAcct('/api/onboarding/whatsapp')));
    if (!ch) return;
    channelId = ch.id;
    fill(qrBox, h('p', { class: 'muted' }, 'Generando código…'));
    const r = await run(() => api('POST', `/api/channels/${ch.id}/whatsapp/connect`));
    if (!r) return fill(qrBox);
    if (r.state === 'open') { fill(qrBox); showState('open'); state.me = null; return; }
    const src = r.qr ? (r.qr.startsWith('data:') ? r.qr : `data:image/png;base64,${r.qr}`) : null;
    fill(qrBox,
      src ? h('img', { class: 'qr', src, alt: 'Código QR de WhatsApp' }) : h('p', { class: 'muted' }, 'No se generó el código; presiona de nuevo.'),
      r.pairingCode ? h('p', {}, 'O vincula con el código: ', h('code', {}, r.pairingCode)) : null,
      h('p', { class: 'small muted' }, 'El código cambia cada ~40 segundos. Si vence, presiona "Generar código" otra vez.'));
    showState('connecting');
    poll();
  };
  box.append(h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Conecta el WhatsApp de tu negocio'),
    h('ol', {},
      h('li', {}, 'Ten a la mano el teléfono con el WhatsApp del negocio (puede ser WhatsApp Business).'),
      h('li', {}, 'Presiona "Generar código".'),
      h('li', {}, 'En el teléfono abre WhatsApp → Configuración → ', h('strong', {}, 'Dispositivos vinculados'), ' → Vincular un dispositivo, y escanea el código.'),
      h('li', {}, 'Listo: los mensajes que lleguen los contesta ', bot.personality?.assistant_name || 'tu asistente', '. Tú puedes seguir usando WhatsApp en el teléfono; si contestas tú, el asistente se pausa en esa conversación.')),
    h('p', { class: 'small muted' }, 'Mantén el teléfono con internet. Si se desconecta, te avisamos por correo y en el panel para que vuelvas a escanear.'),
    h('button', { class: 'primary', onclick: connect }, 'Generar código'),
    status, qrBox));
}

function onbDone(box, ob) {
  box.append(h('div', { class: 'card' },
    h('p', {}, 'Tu asistente está conectado y respondiendo. Esto es lo que puedes hacer ahora:'),
    h('ul', {},
      h('li', {}, h('a', { href: '#/conversations' }, 'Ver las conversaciones'), ' y tomar el control cuando quieras.'),
      ob.chatbot_id ? h('li', {}, h('a', { href: `#/bot/${ob.chatbot_id}/conocimiento` }, 'Agregar más información'), ' o ', h('a', { href: `#/bot/${ob.chatbot_id}/imagenes` }, 'más fotos'), '.') : null,
      h('li', {}, h('a', { href: '#/agenda/servicios' }, 'Configurar tu agenda'), ' para que agende citas solo.'),
      h('li', {}, h('a', { href: '#/automation' }, 'Crear respuestas automáticas y recordatorios'), '.'),
      h('li', {}, h('a', { href: '#/users' }, 'Invitar a tu equipo'), '.'))));
}

/* ------------------------------ Consumo de IA ------------------------------ */

const usd = (n) => `US$${(n || 0).toFixed(n < 1 ? 4 : 2)}`;
const KIND_LABEL = { decision: 'Respuestas', summary: 'Resúmenes de memoria', transcription: 'Notas de voz' };

async function viewUsage(root, params) {
  const month = params.get('month') || new Date().toISOString().slice(0, 7);
  const months = [...Array(6)].map((_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
  const pick = h('select', { style: 'width:auto', onchange: (e) => (location.hash = `#/consumo?month=${e.target.value}`) }, months.map((m) => h('option', { value: m, selected: m === month }, m)));
  const u = await api('GET', withAcct(`/api/usage?month=${month}`));
  root.append(h('div', { class: 'row between' }, h('h1', {}, 'Consumo de IA'), pick));
  if (u.accounts) {
    root.append(
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, usd(u.total_usd)), h('div', { class: 'muted small' }, `Gasto total de OpenAI en ${month} (estimado con la tabla de precios)`)),
      h('div', { class: 'card' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Cuenta'), h('th', {}, 'Estado'), h('th', { class: 'num' }, 'Gasto'), h('th', { class: 'num' }, 'Llamadas'), h('th', { class: 'num' }, 'Tokens entrada'), h('th', { class: 'num' }, 'Tokens salida'), h('th', { class: 'num' }, 'Audio (min)'))),
        h('tbody', {}, u.accounts.map((a) => h('tr', { class: 'click', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } render(); } },
          h('td', {}, a.name), h('td', {}, statusBadge(a)), h('td', { class: 'num' }, usd(a.cost_usd)), h('td', { class: 'num' }, a.calls),
          h('td', { class: 'num' }, Number(a.input_tokens).toLocaleString()), h('td', { class: 'num' }, Number(a.output_tokens).toLocaleString()), h('td', { class: 'num' }, (a.audio_seconds / 60).toFixed(1))))))),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Precios por modelo (USD)'), h('p', { class: 'small muted' }, 'Verifica en openai.com/api/pricing. Un cambio aplica a las llamadas nuevas; el histórico conserva su costo.'), await pricesEditor()),
    );
    return;
  }
  const max = Math.max(...u.days.map((d) => d.cost_usd), 0.000001);
  root.append(
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, usd(u.total_usd)), h('div', { class: 'muted small' }, `Gasto de IA en ${month}`)),
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, u.conversations), h('div', { class: 'muted small' }, 'conversaciones atendidas por la IA')),
      h('div', { class: 'card' }, h('div', { class: 'kpi' }, usd(u.cost_per_conversation)), h('div', { class: 'muted small' }, 'costo promedio por conversación'))),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Por día'),
      u.days.length ? h('div', { class: 'bars' }, u.days.map((d) => h('div', { class: 'bar', title: `${d.day}: ${usd(d.cost_usd)} (${d.calls} llamadas)` }, h('span', { style: `height:${Math.max(2, (d.cost_usd / max) * 100)}%` }), h('small', {}, d.day.slice(8)))))
        : h('p', { class: 'muted' }, 'Sin consumo este mes.')),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Por tipo'), h('table', {}, h('tbody', {}, u.kinds.map((k) => h('tr', {}, h('td', {}, KIND_LABEL[k.kind] || k.kind), h('td', { class: 'num' }, k.calls), h('td', { class: 'num' }, usd(k.cost_usd))))))),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Por modelo'), h('table', {}, h('tbody', {}, u.models.map((m) => h('tr', {}, h('td', {}, m.model), h('td', { class: 'num' }, `${Number(m.input_tokens).toLocaleString()} / ${Number(m.output_tokens).toLocaleString()} tokens`), h('td', { class: 'num' }, usd(m.cost_usd)))))))),
  );
}

async function pricesEditor() {
  const prices = await api('GET', '/api/ai-prices');
  const row = (p) => {
    const f = { input_per_mtok: Number(p.input_per_mtok), cached_per_mtok: Number(p.cached_per_mtok), output_per_mtok: Number(p.output_per_mtok), per_audio_minute: Number(p.per_audio_minute) };
    return h('tr', {}, h('td', {}, p.model),
      ...['input_per_mtok', 'cached_per_mtok', 'output_per_mtok', 'per_audio_minute'].map((k) => h('td', {}, num(f, k, { step: 0.001, min: 0 }))),
      h('td', {}, h('button', { class: 'small', onclick: () => run(() => api('PUT', `/api/ai-prices/${encodeURIComponent(p.model)}`, f), 'Precio guardado') }, 'Guardar')));
  };
  const n = { model: '' };
  return h('div', {},
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Modelo (prefijo)'), h('th', {}, 'Entrada / 1M'), h('th', {}, 'En caché / 1M'), h('th', {}, 'Salida / 1M'), h('th', {}, 'Audio / min'), h('th', {}, ''))),
      h('tbody', {}, prices.map(row))),
    h('div', { class: 'row', style: 'margin-top:8px' }, text(n, 'model', { placeholder: 'gpt-5.1' }),
      h('button', { class: 'small', onclick: async () => { if (n.model && await run(() => api('PUT', `/api/ai-prices/${encodeURIComponent(n.model)}`, {}), 'Modelo agregado')) render(); } }, 'Agregar modelo')));
}

function statusBadge(a) {
  if (a.active === false) return h('span', { class: 'badge red' }, 'desactivada');
  if (a.status === 'paused') return h('span', { class: 'badge red' }, 'en pausa');
  if (a.status === 'trial') {
    const days = a.trial_ends_at ? Math.ceil((new Date(a.trial_ends_at) - Date.now()) / 86400000) : null;
    return h('span', { class: `badge ${days !== null && days <= 3 ? 'orange' : ''}` }, days === null ? 'prueba' : `prueba · ${Math.max(0, days)} d`);
  }
  return h('span', { class: 'badge green' }, a.plan ? `activa · ${a.plan}` : 'activa');
}
