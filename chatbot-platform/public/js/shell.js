import { brand, brandMark, productMark, resetBrand } from './brand.js';
import { api, h, inBackground, invalidateReads, run, state } from './core.js';
import { icon } from './icons.js';
import { render } from './main.js';
import { ROLE_LABEL, copilotAvailable, isAdmin, isSuper, isOwner } from './session.js';

/** Abre o cierra el Copiloto (su módulo se carga solo si la cuenta lo tiene). */
const toggleCopilot = () => import('./copilot.js').then((m) => m.toggleCopilot());

/** Avisos sin leer: en el menú lateral y en la barra del teléfono (solo es una cola cuando hay algo que ver). */
const bells = [h('span', { class: 'count', hidden: true }), h('span', { class: 'count', hidden: true })];

export async function refreshBell() {
  try {
    const n = await inBackground(() => api('GET', '/api/notifications?limit=1'));
    for (const bell of bells) {
      bell.textContent = n.unread > 99 ? '99+' : n.unread;
      bell.hidden = !n.unread;
    }
  } catch { /* sin sesión */ }
}

/** Marca y nombre del producto: el logo de la marca blanca, o la marca propia con su nombre. */
const productName = () => (brand.name === 'Panel de Chatbots' ? 'Riverrun' : brand.name);
const brandBlock = () => (brand.logo ? brandMark(28) : [productMark(), h('span', { class: 'brand-name' }, productName())]);

setInterval(() => { if (state.me && !document.hidden) refreshBell(); }, 20000);

/** Rutas que pertenecen a cada opción del menú lateral. */
const SECTIONS = {
  agentes: ['home', 'agentes', 'asistentes', 'asistente', 'bot', 'channels', 'channel', 'conectar', 'inicio', 'empezar', 'probar'],
  conversations: ['conversations', 'conversation'],
  contacts: ['contacts', 'contact'],
  cobros: ['cobros'],
  agenda: ['agenda'],
  pipeline: ['pipeline'],
  comentarios: ['comentarios'],
  publicaciones: ['publicaciones'],
  cotizaciones: ['cotizaciones'],
  automation: ['automation'],
  estadisticas: ['estadisticas'],
  ajustes: ['ajustes', 'datos-clientes', 'users', 'accounts', 'negocio', 'planes', 'marcas', 'sistema', 'plan', 'consumo', 'logs', 'password', 'integraciones', 'redes'],
};

/** Opciones de Ajustes, agrupadas como un submenú (las de la plataforma solo las ve el superadministrador). */
function settingsGroups() {
  return [
    ['General', [['#/ajustes', 'Resumen', 'ajustes']]],
    ['Mi negocio', [
      ['#/automation/settings', 'Horario y avisos', 'automation/settings'],
      ['#/users', 'Mi equipo', 'users'],
      ['#/datos-clientes', 'Datos de tus clientes', 'datos-clientes'],
      ['#/integraciones', 'Integraciones', 'integraciones'],
      state.meta.zernio_enabled ? ['#/redes', 'Redes sociales', 'redes'] : null,
    ]],
    ['Cuenta', [
      !isSuper() ? ['#/plan', 'Mi plan y pagos', 'plan'] : null,
      ['#/consumo', 'Consumo de IA', 'consumo'],
      ['#/logs', 'Registros', 'logs'],
    ]],
    ['Personal', [['#/password', 'Mi perfil', 'password']]],
    isSuper() ? ['Plataforma', [
      ['#/negocio', 'Tu negocio', 'negocio'],
      ['#/accounts', 'Perfiles de negocio', 'accounts'],
      ['#/planes', 'Planes y cobro', 'planes'],
      ['#/marcas', 'Marca blanca', 'marcas'],
      ['#/sistema', 'Sistema', 'sistema'],
    ]] : null,
  ].filter(Boolean);
}

/** Página de Ajustes en la que se está (null si no es una de Ajustes). */
function settingsPage(active) {
  const path = location.hash.slice(2).split('?')[0];
  if (path.startsWith('automation/settings')) return 'automation/settings';
  return SECTIONS.ajustes.includes(active) ? active : null;
}

/*
 * Menú lateral en tableta y teléfono: al abrir, el foco entra al menú y el resto de la página queda inerte; Escape o el
 * fondo lo cierran y el foco vuelve al botón. Si la ventana crece a escritorio con el menú abierto, se cierra solo.
 */
const desktop = matchMedia('(min-width: 1025px)');
function navKeys(e) {
  // Un Escape que ya atendió otro control (el menú de la cuenta, un diálogo) no cierra también el menú lateral.
  if (!document.querySelector('.layout.nav-open')) return closeNav();
  if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeNav(true); }
}
function openNav() {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  layout.classList.add('nav-open');
  layout.querySelector('.content')?.setAttribute('inert', '');
  layout.querySelector('.nav-toggle')?.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', navKeys);
  desktop.addEventListener('change', closeNavOnDesktop);
  requestAnimationFrame(() => layout.querySelector('.sidebar .nav-item[aria-current], .sidebar .nav-item')?.focus());
}
function closeNav(returnFocus = false) {
  const layout = document.querySelector('.layout');
  document.removeEventListener('keydown', navKeys);
  desktop.removeEventListener('change', closeNavOnDesktop);
  if (!layout?.classList.contains('nav-open')) return;
  layout.classList.remove('nav-open');
  layout.querySelector('.content')?.removeAttribute('inert');
  const toggle = layout.querySelector('.nav-toggle');
  toggle?.setAttribute('aria-expanded', 'false');
  if (returnFocus === true) toggle?.focus();
}
function closeNavOnDesktop() { if (desktop.matches) closeNav(); }

export function shell(active, content) {
  refreshBell();
  const page = isAdmin() ? settingsPage(active) : null;
  const section = page ? 'ajustes' : Object.keys(SECTIONS).find((k) => SECTIONS[k].includes(active)) ?? active;
  const { user, account } = state.me;
  // En la página actual el hash no cambia y no se vuelve a dibujar: el foco regresa al botón del menú.
  const item = (href, iconName, label, key) => h('a', { href, class: `nav-item${section === key ? ' active' : ''}`, 'aria-current': section === key ? 'page' : null, onclick: () => closeNav(location.hash === href) },
    icon(iconName), h('span', {}, label));

  const switcher = isSuper()
    ? h('label', { class: 'account-switch' },
        h('span', { class: 'sr-only' }, 'Perfil de negocio'),
        h('select', { id: 'profile-switch',
          onchange: (e) => {
            state.accountId = e.target.value; invalidateReads();
            // Un enlace que abrió otro perfil (?account_id=, p. ej. desde un aviso de Consumo o Registros) no debe dejarlo fijo.
            if (location.hash.includes('?')) {
              const [route, query] = location.hash.split('?');
              const filters = new URLSearchParams(query);
              if (filters.has('account_id')) {
                filters.delete('account_id');
                history.replaceState(null, '', route + (filters.size ? '?' + filters : ''));
              }
            }
            try { localStorage.setItem('cp-account', state.accountId); } catch { /* */ }
            if (location.hash.startsWith('#/bot/') || location.hash.startsWith('#/channel/') || location.hash.startsWith('#/agentes/conexion/')) { location.hash = '#/agentes'; return; }
            render();
          },
        },
        h('option', { value: '' }, 'Todos los perfiles'),
        state.accounts.map((a) => h('option', { value: a.id, selected: a.id === state.accountId }, a.name + (a.active ? '' : ' (inactiva)')))))
    : h('div', { class: 'account-switch' }, h('strong', {}, account?.name || brand.name), h('span', {}, ROLE_LABEL[user.role]));

  const initials = (user.name || user.email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  // Menú de la cuenta (patrón de botón de menú): flechas, Inicio y Fin entre opciones; Escape cierra y vuelve al botón.
  const items = h('div', { role: 'menu', 'aria-label': 'Tu cuenta',
    onkeydown: (e) => {
      const list = [...items.querySelectorAll('[role=menuitem]')];
      const at = list.indexOf(document.activeElement);
      const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
      if (go !== undefined) { e.preventDefault(); list[(go + list.length) % list.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); setMenu(false); avatar.focus(); }
      else if (e.key === 'Tab') setMenu(false);
    } },
    h('a', { href: '#/password', role: 'menuitem' }, icon('user'), 'Mi perfil'),
    h('a', { href: '#', role: 'menuitem', onclick: async (e) => { e.preventDefault(); await api('POST', '/api/logout'); state.me = null; state.ux = []; window.dispatchEvent(new Event('sessionended')); invalidateReads(); resetBrand(); location.hash = '#/login'; } }, icon('logout'), 'Cerrar sesión'));
  const menu = h('div', { class: 'user-menu', hidden: true },
    h('div', { class: 'user-menu-head' }, h('strong', {}, user.name || user.email), h('span', { class: 'small muted' }, `${user.email} · ${ROLE_LABEL[user.role]}`)),
    items);
  const setMenu = (open, focus) => {
    menu.hidden = !open;
    avatar.setAttribute('aria-expanded', String(open));
    const list = [...items.querySelectorAll('[role=menuitem]')];
    if (open && focus) (focus === 'last' ? list.at(-1) : list[0])?.focus();
  };
  const avatar = h('button', { class: 'user-row', type: 'button', 'aria-label': `${user.name || user.email} ${ROLE_LABEL[user.role]}: menú de tu cuenta`, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); setMenu(menu.hidden, 'first'); },
    onkeydown: (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMenu(true, e.key === 'ArrowUp' ? 'last' : 'first'); } } },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials),
    h('span', { class: 'who' }, h('strong', {}, user.name || user.email), h('span', {}, ROLE_LABEL[user.role])));
  const closeMenu = (e) => {
    if (!avatar.isConnected) return document.removeEventListener('click', closeMenu);
    if (!menu.hidden && !menu.contains(e.target)) setMenu(false);
  };
  document.addEventListener('click', closeMenu);

  const sidebar = h('nav', { class: 'sidebar', id: 'menu-principal', 'aria-label': 'Menú principal' },
    // Sin teclado (lector en el celular) no hay Escape: el menú abierto se cierra con este botón.
    h('button', { class: 'icon-button nav-close', type: 'button', 'aria-label': 'Cerrar el menú', onclick: () => closeNav(true) }, icon('x', 20)),
    h('div', { class: 'brand' }, brandBlock()),
    switcher,
    h('div', { class: 'nav-list' },
      isAdmin() ? item('#/agentes', 'bot', 'Agentes', 'agentes') : null,
      item('#/conversations', 'chat', 'Conversaciones', 'conversations'),
      item('#/contacts', 'contacts', 'Contactos', 'contacts'),
      item('#/agenda', 'calendar', 'Calendarios', 'agenda'),
      item('#/pipeline', 'pipeline', 'Oportunidades', 'pipeline'),
      state.meta.zernio_enabled ? item('#/comentarios', 'comments', 'Comentarios', 'comentarios') : null,
      isAdmin() && state.meta.zernio_enabled ? item('#/publicaciones', 'megaphone', 'Publicaciones', 'publicaciones') : null,
      isAdmin() ? item('#/cotizaciones', 'quote', 'Cotizaciones', 'cotizaciones') : null,
      state.meta.receivables_enabled ? item('#/cobros', 'card', 'Cobros', 'cobros') : null,
      isAdmin() ? item('#/automation', 'zap', 'Automatización', 'automation') : null,
      isAdmin() ? item('#/estadisticas', 'chart', 'Reportes', 'estadisticas') : null),
    h('div', { class: 'spacer' }),
    h('div', { class: 'nav-foot' },
      copilotAvailable() ? h('button', { type: 'button', class: 'nav-item cp-launch', 'data-copilot-launcher': '', 'aria-controls': 'copilot', 'aria-expanded': 'false', title: 'Copiloto (Ctrl + .)', onclick: () => { closeNav(); return toggleCopilot(); } }, icon('wand'), h('span', {}, 'Copiloto')) : null,
      isAdmin() ? item('#/ajustes', 'settings', 'Ajustes', 'ajustes') : item('#/password', 'user', 'Mi perfil', 'ajustes'),
      h('a', { href: '#/notifications', class: `nav-item${active === 'notifications' ? ' active' : ''}`, 'aria-current': active === 'notifications' ? 'page' : null, onclick: closeNav },
        icon('bell'), h('span', {}, 'Notificaciones'), bells[0]),
      h('a', { href: '/ayuda.html', class: 'nav-item', target: '_blank', rel: 'noopener' }, icon('help'), h('span', {}, 'Ayuda')),
      h('div', { class: 'user-menu-wrap' }, avatar, menu)),
  );

  // Tableta y teléfono: el menú lateral se pliega en esta barra (marca, avisos y el botón del menú).
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'icon-button nav-toggle', type: 'button', 'aria-label': 'Abrir el menú', 'aria-controls': 'menu-principal', 'aria-expanded': 'false', onclick: openNav }, icon('menu', 20)),
    h('div', { class: 'topbar-title' }, brandBlock()),
    h('div', { class: 'topbar-actions' },
      copilotAvailable() ? h('button', { type: 'button', class: 'icon-button', 'data-copilot-launcher': '', 'aria-controls': 'copilot', 'aria-expanded': 'false', 'aria-label': 'Copiloto', title: 'Copiloto', onclick: toggleCopilot }, icon('wand', 20)) : null,
      h('a', { class: `icon-button${active === 'notifications' ? ' active' : ''}`, href: '#/notifications', 'aria-label': 'Notificaciones', title: 'Notificaciones' }, icon('bell', 20), bells[1])));

  const body = page ? h('div', { class: 'settings-layout' }, settingsNav(page), h('div', { class: 'settings-body' }, content)) : content;
  // «Saltar al contenido»: el hash es la ruta, así que el enlace enfoca <main> sin cambiarlo.
  const skip = h('a', { class: 'skip-link', href: '#contenido', onclick: (e) => { e.preventDefault(); document.getElementById('contenido')?.focus(); } }, 'Saltar al contenido');
  return h('div', { class: 'layout' },
    skip,
    sidebar,
    h('div', { class: 'scrim', onclick: () => closeNav(true) }),
    h('div', { class: 'content' }, topbar, h('main', { class: 'main', id: 'contenido', tabindex: '-1' }, accountBanner(), body)));
}

/** Submenú de Ajustes (a la izquierda; en el teléfono, arriba). */
function settingsNav(page) {
  return h('nav', { class: 'settings-nav', 'aria-label': 'Ajustes' },
    settingsGroups().map(([title, links]) => h('div', { class: 'settings-group' },
      h('div', { class: 'settings-group-title' }, title),
      links.filter(Boolean).map(([href, label, key]) => h('a', { href, class: page === key ? 'active' : '', 'aria-current': page === key ? 'page' : null }, label)))));
}

/** Aviso de la cuenta: días de prueba, cuenta en pausa o correo sin confirmar. */
function accountBanner() {
  const { user, account } = state.me;
  if (!account) return null;
  const items = [];
  // Una línea: el texto y, al final, su acción (un botón con borde: el relleno es de la acción principal de la página).
  const notice = (cls, text, action = null, attrs = {}) => h('div', { class: `banner ${cls}`, ...attrs }, h('span', { class: 'text' }, text), action);
  if (account.deletion_scheduled_for && isAdmin()) {
    items.push(notice('danger', [h('strong', {}, 'Tu cuenta se va a borrar. '),
      `Pediste borrarla y se borrará el ${new Date(account.deletion_scheduled_for).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })}. `],
      location.hash.split('?')[0] === '#/plan' ? null : h('a', { class: 'btn', href: '#/plan' }, 'Cancelar el borrado'), { role: 'status' }));
  }
  const due = account.payment_due;
  if (due && due.action_url && account.status !== 'paused' && isAdmin()) {
    // El banco detuvo el cobro hasta que se confirme (3DS): la tarjeta está bien, solo hay que confirmarlo.
    items.push(notice('warn', [h('strong', {}, 'Tu banco pide que confirmes el pago de tu plan. '),
      `Confírmalo antes del ${new Date(due.grace_ends_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })} para que tu asistente siga respondiendo. `],
      h('a', { class: 'btn', href: due.action_url, target: '_blank', rel: 'noopener' }, 'Confirmar pago'), { role: 'status' }));
  } else if (due && account.status !== 'paused' && isAdmin()) {
    items.push(notice('warn', [h('strong', {}, 'No pudimos cobrar tu plan. '),
      `Actualiza tu forma de pago antes del ${new Date(due.grace_ends_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })} para que tu asistente siga respondiendo. `],
      location.hash.split('?')[0] === '#/plan' ? null : h('a', { class: 'btn', href: '#/plan' }, 'Actualizar pago'), { role: 'status' }));
  }
  const cc = state.me.card_check;
  if (account.status === 'paused' && account.pause_reason === 'card') {
    // Esperando tarjeta: el paso que falta (correo, tarjeta, o ya no hay prueba). Lo resuelve el dueño en Mi plan.
    const onPlan = location.hash.split('?')[0] === '#/plan';
    const go = (label) => (onPlan || !isAdmin() ? null : h('a', { class: 'btn', href: '#/plan' }, label));
    if (!isAdmin()) items.push(notice('warn', [h('strong', {}, 'La cuenta todavía no activa su prueba. '), 'El dueño la activa desde Mi plan.'], null, { role: 'status' }));
    else if (cc?.charging) {
      items.push(notice('', [h('strong', {}, 'Estamos activando tu plan. '), 'Se activa en cuanto se confirme su primer cobro.'], null, { role: 'status' }));
    } else if (cc && !cc.email_verified) {
      items.push(notice('warn', [h('strong', {}, 'Falta verificar tu correo. '), isOwner() ? 'Abre el enlace que te enviamos para activar tu prueba.' : 'El dueño de la cuenta tiene que abrir el enlace que le enviamos.'],
        isOwner() ? h('button', { class: 'btn', onclick: () => run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace') }, 'Reenviar') : null, { role: 'status' }));
    } else if (cc?.card_used) {
      items.push(notice('warn', [h('strong', {}, 'Esta tarjeta ya tuvo una prueba gratis. '), 'Puedes usar otra tarjeta o contratar ya.'], go('Usar otra tarjeta'), { role: 'status' }));
    } else if (cc && !cc.trial_available) {
      items.push(notice('warn', [h('strong', {}, 'Ya usaste tu prueba gratis. '), 'Elige tu plan para activar tu asistente.'], go('Contratar'), { role: 'status' }));
    } else {
      const days = cc?.trial_days || 14;
      const until = new Date(Date.now() + days * 86400000).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
      items.push(notice('', [h('strong', {}, `Activa tu prueba gratis de ${days} días: agrega tu tarjeta. `), `No se cobra nada hasta el ${until}.`], go('Agregar tarjeta'), { role: 'status' }));
    }
  } else if (account.status === 'paused') {
    items.push(notice('danger', [h('strong', {}, 'Tu cuenta está en pausa. '),
      'Tu asistente no está respondiendo ni enviando mensajes; tu configuración y tus conversaciones se conservan',
      account.deletion_date ? ` hasta el ${new Date(account.deletion_date).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })}.` : '.',
      !(state.meta.billing_enabled && isAdmin()) && state.meta.support_contact ? [' Para activarla escribe a ', h('strong', {}, state.meta.support_contact), '.'] : ''],
      state.meta.billing_enabled && isAdmin() ? h('a', { class: 'btn', href: '#/plan' }, 'Activar mi plan') : null));
  } else if (account.status === 'trial' && account.trial_ends_at) {
    const days = Math.max(0, Math.ceil((new Date(account.trial_ends_at) - Date.now()) / 86400000));
    items.push(notice(days <= 3 ? 'warn' : '', [`Periodo de prueba: ${days === 0 ? 'termina hoy' : days === 1 ? 'queda 1 día' : `quedan ${days} días`}.`,
      !(state.meta.billing_enabled && isAdmin()) && state.meta.support_contact ? [' Para contratar escribe a ', h('strong', {}, state.meta.support_contact), '.'] : ''],
      state.meta.billing_enabled && isAdmin() ? h('a', { class: 'btn', href: '#/plan' }, 'Contratar ahora') : null));
  }
  const here = location.hash.split('?')[0];
  // Donde ya se está creando el agente o conectando el teléfono, estos avisos estorban (la página ya lo resuelve).
  const startPage = /^#\/bot\/[^/]+\/empezar$/.test(here);
  const setupPage = startPage || ['#/agentes/nuevo', '#/empezar', '#/conectar', '#/inicio'].includes(here) || here.startsWith('#/channel/') || /^#\/bot\/[^/]+\/conexiones\//.test(here);
  // En Agentes cada panel ya dice qué teléfono falta conectar, con su botón: el aviso general sería la misma noticia dos veces.
  const agentsHome = ['', '#/', '#/agentes', '#/home'].includes(here);
  if (state.wa && !state.wa.connected && isAdmin() && !setupPage && !agentsHome) {
    items.push(notice('warn', [h('strong', {}, state.wa.has ? 'Tu WhatsApp no está conectado. ' : 'Aún no conectas tu WhatsApp. '),
      'Tu agente no puede responder hasta que lo vincules.'],
      h('a', { class: 'btn', href: state.wa.has && state.wa.id ? `#/channel/${state.wa.id}` : '#/empezar' }, state.wa.has ? 'Volver a conectarlo' : 'Conectar mi WhatsApp')));
  }
  // Crear el agente no necesita el correo confirmado: se pide en la pantalla de conectar, donde sí hace falta.
  if (!user.email_verified_at && state.meta.require_email && !startPage && here !== '#/agentes/nuevo') {
    items.push(notice('warn', `Confirma tu correo (${user.email}) con el enlace que te enviamos para poder conectar tu WhatsApp. `,
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); if (!(await run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace'))) return; } }, 'Reenviar correo')));
  }
  return items.length ? h('div', { class: 'stack account-notices', style: 'margin-bottom:20px' }, items) : null;
}

/** Cuenta del autorregistro que todavía no conecta su primer WhatsApp: le falta terminar de configurar su agente. */
export function needsOnboarding() {
  const acc = state.me?.account;
  return !isSuper() && isAdmin() && acc && acc.signup_source === 'signup' && !acc.onboarding?.done && !acc.onboarding?.whatsapp;
}
