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
  if (!state.me) {
    try {
      await loadSession();
    } catch {
      return;
    }
  }
  // Los agentes solo atienden conversaciones.
  if (!isAdmin() && !['conversations', 'conversation', 'password'].includes(parts[0])) {
    location.hash = '#/conversations';
    return;
  }
  const content = h('div');
  fill($app, shell(parts[0] || 'home', content));
  try {
    if (!parts.length) await viewDashboard(content);
    else if (parts[0] === 'bot') await viewBot(content, parts[1], parts[2] || 'general');
    else if (parts[0] === 'channels') await viewChannels(content, params);
    else if (parts[0] === 'channel') await viewChannel(content, parts[1]);
    else if (parts[0] === 'conversations') await viewConversations(content, params);
    else if (parts[0] === 'conversation') await viewConversation(content, parts[1]);
    else if (parts[0] === 'users') await viewUsers(content);
    else if (parts[0] === 'accounts') await viewAccounts(content);
    else if (parts[0] === 'logs') await viewLogs(content, params);
    else if (parts[0] === 'password') await viewPassword(content);
    else content.append(h('p', {}, 'Página no encontrada'));
  } catch (e) {
    content.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, e.message)));
  }
}

function shell(active, content) {
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
      isAdmin() ? link('#/', 'Chatbots', 'home') : null,
      isAdmin() ? link('#/channels', 'Canales', 'channels') : null,
      link('#/conversations', 'Conversaciones', 'conversations'),
      isAdmin() ? link('#/users', 'Usuarios', 'users') : null,
      isSuper() ? link('#/accounts', 'Cuentas', 'accounts') : null,
      isAdmin() ? link('#/logs', 'Registros', 'logs') : null,
      h('div', { class: 'spacer' }),
      h('div', { class: 'small muted', style: 'padding:4px 10px' }, user.name || user.email, h('br'), ROLE_LABEL[user.role]),
      link('#/password', 'Cambiar contraseña', 'password'),
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/api/logout'); state.me = null; location.hash = '#/login'; } }, 'Cerrar sesión'),
    ),
    h('main', { class: 'main' }, content),
  );
}

function renderLogin() {
  const f = { email: '', password: '' };
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
    ),
  );
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
  const nb = { name: '' };
  const createBox = h('div', { class: 'card', hidden: true },
    h('h3', { style: 'margin-top:0' }, 'Nuevo chatbot'),
    field('Nombre', text(nb, 'name', { placeholder: 'Hotel Las Palmas' })),
    accountPicker(nb),
    h('button', { class: 'primary', onclick: async () => {
      if (!nb.name.trim()) return toast('Escribe un nombre', true);
      const bot = await run(() => api('POST', '/api/chatbots', nb));
      if (bot) location.hash = `#/bot/${bot.id}/general`;
    } }, 'Crear'));
  const noAccounts = isSuper() && !state.accounts.length;
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Chatbots'),
      h('button', { class: 'primary', disabled: noAccounts, onclick: () => (createBox.hidden = !createBox.hidden) }, '+ Nuevo chatbot')),
    noAccounts ? h('div', { class: 'card' }, h('p', {}, 'Primero crea una cuenta (cliente) en ', h('a', { href: '#/accounts' }, 'Cuentas'), '.')) : null,
    createBox,
    bots.length || noAccounts ? null : h('div', { class: 'card' }, h('p', {}, 'Aún no hay chatbots. Crea el primero para empezar.')),
    h('div', { class: 'grid' },
      bots.map((b) => {
        const s = byId[b.id] || {};
        const mine = channels.filter((c) => c.chatbot_id === b.id);
        return h('div', { class: 'card' },
          h('div', { class: 'row between' },
            h('h3', { style: 'margin:0' }, h('a', { href: `#/bot/${b.id}/general` }, b.name)),
            h('span', { class: `badge ${b.active ? 'green' : ''}` }, b.active ? 'Activo' : 'Inactivo')),
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

const TABS = [
  ['general', 'General'],
  ['personalidad', 'Personalidad'],
  ['conocimiento', 'Conocimiento'],
  ['imagenes', 'Imágenes'],
  ['reglas', 'Reglas'],
  ['datos', 'Datos a recopilar'],
  ['flujo', 'Flujo'],
  ['ia', 'IA y memoria'],
  ['probar', 'Probar'],
];

async function viewBot(root, id, tab) {
  const bot = await api('GET', `/api/chatbots/${id}`);
  root.append(
    h('div', { class: 'row between' },
      h('h1', {}, bot.name, ' ', h('span', { class: `badge ${bot.active ? 'green' : ''}` }, bot.active ? 'Activo' : 'Inactivo')),
      h('a', { href: `#/conversations?chatbot_id=${bot.id}` }, 'Ver conversaciones →')),
    h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { href: `#/bot/${id}/${k}`, class: k === tab ? 'active' : '' }, l))),
  );
  const body = h('div');
  root.append(body);
  const views = { general: tabGeneral, personalidad: tabPersonality, conocimiento: tabKnowledge, imagenes: tabImages, reglas: tabRules, datos: tabData, flujo: tabFlow, ia: tabAi, probar: tabPlayground };
  await (views[tab] || tabGeneral)(body, bot);
}

function saveBar(onSave, extra) {
  return h('div', { class: 'sticky-save row' }, h('button', { class: 'primary', onclick: onSave }, 'Guardar cambios'), extra);
}

async function saveBot(bot, patch) {
  return run(() => api('PUT', `/api/chatbots/${bot.id}`, patch), 'Guardado ✅');
}

function tabGeneral(root, bot) {
  const m = { name: bot.name, active: bot.active };
  const channels = bot.channels || [];
  const dup = { account_id: bot.account_id };
  root.append(
    h('div', { class: 'card' },
      field('Nombre del chatbot / negocio', text(m, 'name')),
      check(m, 'active', 'Activo (responde automáticamente en sus canales)'),
      isSuper() ? h('p', { class: 'muted small' }, 'Cuenta: ', accountName(bot.account_id)) : null,
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Canales que atiende'),
        h('a', { class: 'btn', href: `#/channels?new=1&chatbot_id=${bot.id}` }, '+ Agregar canal')),
      h('p', { class: 'muted small' }, 'El mismo chatbot (prompt, información, imágenes y reglas) responde en todos sus canales.'),
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
      field('Prompt principal', area(p, 'prompt', { big: true, placeholder: 'Ej.: Eres parte del equipo de recepción del Hotel Las Palmas en Cancún. Tu objetivo es resolver dudas y ayudar a que el cliente reserve. Eres cálido, atento y vas al grano...' }),
        'Quién es, a quién atiende y qué busca lograr. La información del negocio va en "Conocimiento", no aquí.'),
      field('Tono', toneInput, 'Separado por comas.'),
      h('div', { class: 'row', style: 'margin:-6px 0 14px' }, TONE_PRESETS.map((t) => h('button', { class: 'small', onclick: () => addTone(t) }, `+ ${t}`))),
      h('div', { class: 'grid' },
        field('Idioma', text(p, 'language')),
        field('Trato', select(p, 'formality', [['tu', 'Tú'], ['usted', 'Usted']])),
        field('Longitud de respuestas', select(p, 'response_length', [['muy_corta', 'Muy corta'], ['corta', 'Corta'], ['media', 'Media'], ['detallada', 'Detallada']])),
        field('Emojis', select(p, 'emojis', [['none', 'Sin emojis'], ['few', 'Pocos'], ['normal', 'Normal']])),
      ),
      field('Ejemplos de estilo', lines(p, 'style_examples', { placeholder: 'Mensajes reales de cómo escribe el negocio, uno por renglón.\nEj.: ¡Hola! Claro, con gusto te ayudo 😊' }),
        'Opcional. La IA imita el estilo (no copia el texto).'),
    ),
    saveBar(async () => { if (await saveBot(bot, { personality: p })) render(); }),
  );
}

async function tabKnowledge(root, bot) {
  const items = await api('GET', `/api/chatbots/${bot.id}/knowledge`);
  const cats = state.meta.knowledge_categories;
  const catOptions = cats.map((c) => [c, c.replace(/_/g, ' ')]);
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
              h('span', { class: 'badge' }, it.category.replace(/_/g, ' ')), ' ',
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
          check(m, 'always_include', 'Incluir siempre (información esencial)'),
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
      h('p', { class: 'muted' },
        'Todo lo que el bot puede decir sobre el negocio sale de aquí. Si un dato no está, el bot no lo inventa. ',
        'Escribe con datos concretos: precios, horarios, direcciones, condiciones, preguntas frecuentes.'),
      h('p', { class: 'small muted' }, `${items.length} elementos · ${total.toLocaleString()} caracteres activos (presupuesto por mensaje: ${bot.ai.knowledge_char_budget.toLocaleString()}; si se excede, se envían los más relevantes).`),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Agregar información'),
      h('div', { class: 'grid' }, field('Categoría', select(newItem, 'category', catOptions)), field('Título', text(newItem, 'title', { placeholder: 'Ej.: Precios de habitaciones' }))),
      field('Contenido', area(newItem, 'content', { big: true, placeholder: 'Habitación sencilla: $1,200 MXN por noche...\nHabitación doble: $1,650 MXN por noche...' })),
      check(newItem, 'always_include', 'Incluir siempre (información esencial)'),
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', `/api/chatbots/${bot.id}/knowledge`, newItem), 'Agregado')) render(); } }, 'Agregar'),
    ),
    ...cats.filter((c) => items.some((i) => i.category === c)).map((c) =>
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0;text-transform:capitalize' }, c.replace(/_/g, ' ')), items.filter((i) => i.category === c).map(itemView))),
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
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Cero invenciones'),
      field('Si el dato no está en la información del negocio…', select(r, 'unknown_info_behavior', [['say_unknown', 'Decir que no lo tiene confirmado'], ['ask', 'Hacer una pregunta para aclarar'], ['handoff', 'Transferir a una persona']])),
      field('Mensaje de respaldo', area(r, 'fallback_message'), 'Se usa si la IA insiste en dar un dato que no puede verificarse.'),
      check(r, 'verify_facts', 'Verificar precios, números, links, correos y teléfonos antes de enviar (recomendado)'),
      field('Frases prohibidas', lines(r, 'banned_phrases'), 'Si la respuesta contiene alguna, se regenera.'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Temas'),
      field('De qué puede hablar', area(r, 'allowed_topics', { placeholder: 'Reservaciones, habitaciones, servicios del hotel, ubicación' })),
      field('Temas que NO debe tratar', lines(r, 'forbidden_topics', { placeholder: 'Política\nCompetencia\nTemas médicos' })),
      field('Reglas específicas', lines(r, 'custom_rules', { big: true, placeholder: 'Nunca ofrezcas descuentos\nSiempre pregunta las fechas antes de dar disponibilidad\nNo confirmes reservaciones: eso lo hace una persona' })),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Imágenes'),
      field('Cuándo mandar imágenes (criterio general)', area(r, 'image_rules', { placeholder: 'Envía fotos cuando el cliente muestre interés en una habitación concreta o pida verla.' })),
      field('Máximo de imágenes por respuesta', num(r, 'max_images_per_reply', { min: 0, max: 5 })),
      check(r, 'avoid_repeating_images', 'No reenviar imágenes ya enviadas (salvo que el cliente las pida)'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Transferir a una persona'),
      field('Cuándo transferir', lines(r, 'handoff_rules')),
      field('Palabras clave que transfieren de inmediato', lines(r, 'handoff_keywords'), 'Sin pasar por la IA.'),
      field('Mensaje al transferir', area(r, 'handoff_message')),
      field('Número que recibe el aviso de transferencia', text(r, 'handoff_notify_number', { placeholder: '5215512345678' }), 'Opcional. Se le manda un WhatsApp cuando alguien necesita atención.'),
      check(r, 'pause_on_human_reply', 'Pausar el bot si alguien responde manualmente desde el teléfono'),
      field('Retomar automáticamente después de (minutos)', num(r, 'auto_resume_minutes', { min: 0 }), '0 = el bot no retoma solo; hay que devolverle la conversación desde el panel.'),
    ),
    saveBar(async () => { if (await saveBot(bot, { rules: r })) render(); }),
  );
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
            field('Clave', text(f, 'key', { placeholder: 'correo' }), 'minúsculas_y_guion_bajo'),
            field('Etiqueta', text(f, 'label', { placeholder: 'Correo electrónico' })),
            field('Tipo', select(f, 'type', types, draw))),
          f.type === 'option' ? field('Opciones válidas', lines(f, 'options')) : null,
          field('Descripción', text(f, 'description', { placeholder: 'Para enviarle la confirmación' })),
          field('Cuándo pedirlo', text(f, 'ask_when', { placeholder: 'Cuando quiera cotizar o reservar' })),
          check(f, 'required', 'Importante'),
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
      h('p', { class: 'muted' }, 'Datos que el bot irá recopilando de forma natural (sin formulario). Los valores se validan (correo, teléfono, opciones) antes de guardarse y nunca se vuelven a pedir.'),
      list,
      h('button', { onclick: () => { fields.push({ key: '', label: '', type: 'text', description: '', options: [], required: false, ask_when: '' }); draw(); } }, '+ Agregar dato'),
    ),
    saveBar(async () => { if (await saveBot(bot, { data_fields: fields })) render(); }),
  );
}

function tabFlow(root, bot) {
  const f = clone(bot.flow);
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
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'Es una guía, no un guion: el cliente puede saltar pasos o dar todo junto y el bot se adapta.'),
      field('Objetivo de la conversación', area(f, 'goal', { placeholder: 'Que el cliente haga una reservación o deje sus datos para que un asesor lo contacte.' })),
      field('Saludo sugerido', text(f, 'greeting', { placeholder: '¡Hola! Gracias por escribir al Hotel Las Palmas 🌴' })),
      h('h3', {}, 'Etapas sugeridas'),
      list,
      h('button', { onclick: () => { f.steps.push({ title: '', description: '' }); draw(); } }, '+ Agregar etapa'),
      h('div', { style: 'margin-top:14px' }, field('Cuando se cumpla el objetivo', area(f, 'on_goal_completed', { placeholder: 'Agradece, confirma los datos recibidos y transfiere a una persona para cerrar la reservación.' }))),
    ),
    saveBar(async () => { if (await saveBot(bot, { flow: f })) render(); }),
  );
}

function tabAi(root, bot) {
  const a = clone(bot.ai);
  root.append(
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Modelo'),
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
      h('h3', { style: 'margin-top:0' }, 'Comportamiento en WhatsApp'),
      h('div', { class: 'grid' },
        field('Esperar antes de responder (segundos)', num(a, 'debounce_seconds', { min: 0, max: 60, step: 0.5 }), 'Agrupa mensajes seguidos del cliente.'),
        field('Máximo de mensajes por respuesta', num(a, 'max_bubbles', { min: 1, max: 5 })),
        field('Máximo de caracteres por mensaje', num(a, 'max_chars_per_bubble', { min: 80, max: 2000 })),
        field('Zona horaria', text(a, 'timezone'))),
      check(a, 'typing_simulation', 'Mostrar "escribiendo…" antes de cada mensaje'),
      check(a, 'transcribe_audio', 'Transcribir notas de voz (usa la API de audio de OpenAI)'),
    ),
    saveBar(async () => { if (await saveBot(bot, { ai: a })) render(); }),
  );
}

async function tabPlayground(root, bot) {
  const session = localStorage.getItem('pg-session') || Math.random().toString(36).slice(2, 10);
  try { localStorage.setItem('pg-session', session); } catch { /* sin storage */ }
  const chat = h('div', { class: 'chat' });
  const debug = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Aquí verás la decisión de la IA y la validación del backend.'));
  const input = h('textarea', { placeholder: 'Escribe como si fueras el cliente…', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  const btn = h('button', { class: 'primary', onclick: () => send() }, 'Enviar');

  const bubble = (cls, content, img) =>
    h('div', { class: `bubble ${cls}` }, img ? h('img', { src: `/api/images/${img.id}/file` }) : null, img ? h('div', { class: 'small muted' }, `🖼 ${img.code}`) : null, content || null);

  const load = async () => {
    const d = await api('GET', `/api/chatbots/${bot.id}/playground/${session}`);
    fill(chat, ...d.messages.map((m) => bubble(m.direction === 'in' ? 'in' : 'out', m.content, m.image_id ? { id: m.image_id, code: m.image_code } : null)));
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
    for (const o of r.outputs) chat.append(o.type === 'notify' ? bubble('notify', o.text) : bubble('out', o.text, o.image));
    if (r.result.status === 'no_reply') chat.append(bubble('notify', '(la IA decidió no responder)'));
    if (r.result.status === 'human') chat.append(bubble('notify', '(conversación en modo humano: el bot no responde)'));
    if (r.result.status === 'error') chat.append(bubble('notify', `Error: ${r.result.error}`));
    chat.scrollTop = chat.scrollHeight;
    const c = r.contact || {};
    fill(debug, 
      h('div', {}, h('strong', {}, 'Acción: '), h('code', {}, r.result.action || r.result.status), r.result.fallback_used ? h('span', { class: 'badge orange' }, ' respaldo') : null, r.result.info_not_found ? h('span', { class: 'badge orange' }, ' dato no encontrado') : null),
      r.result.thinking ? h('div', {}, h('strong', {}, 'Razonamiento: '), h('span', { class: 'muted' }, r.result.thinking)) : null,
      ...r.result.attempts.map((a, i) => h('div', { class: 'small' }, h('strong', {}, `Intento ${i + 1}: `),
        a.retryable.length ? h('span', { class: 'badge red' }, 'rechazado') : h('span', { class: 'badge green' }, 'aprobado'),
        a.retryable.length ? h('div', { class: 'muted' }, a.retryable.join(' · ')) : null,
        a.fixes.length ? h('div', { class: 'muted' }, 'Correcciones: ', a.fixes.join(' · ')) : null)),
      h('div', {}, h('strong', {}, 'Estado: '), r.conversation?.status === 'human' ? h('span', { class: 'badge orange' }, 'con humano') : h('span', { class: 'badge green' }, 'bot')),
      h('div', {}, h('strong', {}, 'Nombre: '), c.name || '—'),
      h('div', {}, h('strong', {}, 'Datos: '), h('pre', { class: 'small pre' }, JSON.stringify(c.data || {}, null, 2))),
      c.notes?.length ? h('div', {}, h('strong', {}, 'Notas: '), h('ul', {}, c.notes.map((n) => h('li', {}, n)))) : null,
      r.conversation?.summary ? h('div', {}, h('strong', {}, 'Resumen: '), h('div', { class: 'small pre muted' }, r.conversation.summary)) : null,
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
        h('p', { class: 'muted small' }, 'Usa exactamente el mismo motor, contexto y validaciones que WhatsApp (funciona aunque el bot esté inactivo). Las imágenes se muestran aquí en lugar de enviarse.'),
        chat,
        h('div', { class: 'composer' }, input, btn)),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Depuración'), debug),
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

  const drawSide = () => {
    const { conversation: c, contact: ct } = data;
    const m = { name: ct.name, data: { ...ct.data }, notes: [...(ct.notes || [])] };
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
        h('button', { class: 'small', onclick: async () => { await run(() => api('PUT', `/api/contacts/${ct.id}`, { ...m, data: Object.fromEntries(Object.entries({ ...m.data, ...Object.fromEntries(nameKeys.map((k) => [k, m.name])) }).filter(([, v]) => v)) }), 'Datos guardados'); } }, 'Guardar datos')),
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
      return [
        field('Instancia de Evolution', text(cfg, 'instance', { placeholder: 'hotel_palmas' }), 'Nombre único (letras, números, guion y guion bajo). Se crea sola al conectar.'),
        field('Número de WhatsApp', text(cfg, 'number', { placeholder: '5215512345678' }), 'Con lada de país; opcional, como referencia.'),
        h('details', {}, h('summary', {}, 'Servidor de Evolution distinto al global (opcional)'),
          h('div', { style: 'margin-top:10px' },
            field('URL de Evolution', text(cfg, 'url', { placeholder: 'Vacío = usar EVOLUTION_URL' })),
            secret('api_key', 'API key de Evolution', 'Vacío = usar EVOLUTION_API_KEY'))),
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
        h('button', { class: 'primary', onclick: connect, disabled: !ch.config.instance }, 'Conectar / mostrar QR'),
        h('button', { onclick: setup, disabled: !ch.config.instance }, 'Reconfigurar webhook'),
        h('button', { class: 'danger', disabled: !ch.config.instance, onclick: async () => { if (confirm('¿Desvincular este WhatsApp?')) { await run(() => api('POST', `/api/channels/${id}/whatsapp/logout`), 'Desconectado'); refresh(); } } }, 'Desconectar')),
      qrBox,
      h('h3', {}, 'Mensaje de prueba'),
      h('div', { class: 'grid' }, field('Número (con lada)', text(test, 'number', { placeholder: '5215512345678' })), field('Texto', text(test, 'text'))),
      h('button', { disabled: !ch.config.instance, onclick: () => run(() => api('POST', `/api/channels/${id}/whatsapp/test`, test), 'Enviado') }, 'Enviar'),
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
  const n = { name: '', email: '', password: '', role: 'agent' };
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
        field('Rol', select(n, 'role', roles))),
      accountPicker(n),
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', '/api/users', n), 'Usuario creado')) render(); } }, 'Crear usuario')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Usuario'), h('th', {}, 'Rol'), isSuper() ? h('th', {}, 'Cuenta') : null, h('th', {}, 'Último acceso'), h('th', {}, ''))),
        h('tbody', {}, users.map((u) => {
          const self = u.id === me.id;
          return h('tr', {},
            h('td', {}, h('strong', {}, u.name || '—'), h('div', { class: 'muted small' }, u.email), !u.active ? h('span', { class: 'badge orange' }, 'desactivado') : null),
            h('td', {}, u.role === 'superadmin' || self ? ROLE_LABEL[u.role]
              : h('select', { onchange: async (e) => { if (await run(() => api('PUT', `/api/users/${u.id}`, { role: e.target.value }), 'Rol actualizado')) render(); } },
                  [['agent', 'Agente'], ['admin', 'Administrador']].map(([v, l]) => h('option', { value: v, selected: u.role === v }, l)))),
            isSuper() ? h('td', { class: 'small' }, u.account_id ? accountName(u.account_id) : '—') : null,
            h('td', { class: 'small muted' }, u.last_login_at ? fmtDate(u.last_login_at) : 'nunca'),
            h('td', {}, self ? h('span', { class: 'muted small' }, 'tú') : h('div', { class: 'row' },
              h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/users/${u.id}`, { active: !u.active }), u.active ? 'Desactivado' : 'Activado')) render(); } }, u.active ? 'Desactivar' : 'Activar'),
              h('button', { class: 'small', onclick: async () => { const pw = prompt('Nueva contraseña (mínimo 8 caracteres)'); if (pw) await run(() => api('PUT', `/api/users/${u.id}`, { password: pw }), 'Contraseña actualizada'); } }, 'Restablecer contraseña'),
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
        h('thead', {}, h('tr', {}, h('th', {}, 'Cuenta'), h('th', {}, 'Chatbots'), h('th', {}, 'Canales'), h('th', {}, 'Usuarios'), h('th', {}, 'Conversaciones'), h('th', {}, ''))),
        h('tbody', {}, accounts.map((a) => h('tr', {},
          h('td', {}, h('strong', {}, a.name), ' ', !a.active ? h('span', { class: 'badge orange' }, 'inactiva') : null),
          h('td', {}, a.chatbots), h('td', {}, a.channels), h('td', {}, a.users), h('td', {}, a.conversations),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'small', onclick: () => { state.accountId = a.id; try { localStorage.setItem('cp-account', a.id); } catch { /* */ } location.hash = '#/'; } }, 'Abrir'),
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
  root.append(
    h('h1', {}, 'Cambiar contraseña'),
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
