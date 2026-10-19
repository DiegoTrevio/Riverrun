import { brand, brandMark, resetBrand } from './brand.js';
import { api, h, invalidateReads, run, state } from './core.js';
import { icon } from './icons.js';
import { render } from './main.js';
import { ROLE_LABEL, isAdmin, isSuper } from './session.js';

const bell = h('span', { class: 'count', hidden: true });

export async function refreshBell() {
  try {
    const n = await api('GET', '/api/notifications?limit=1');
    bell.textContent = n.unread > 99 ? '99+' : n.unread;
    bell.hidden = !n.unread;
  } catch { /* sin sesión */ }
}

setInterval(() => { if (state.me && !document.hidden) refreshBell(); }, 20000);

/** Rutas que pertenecen a cada opción del menú lateral. */
const SECTIONS = {
  agentes: ['home', 'agentes', 'asistentes', 'asistente', 'bot', 'channels', 'channel', 'conectar', 'inicio', 'probar'],
  conversations: ['conversations', 'conversation'],
  contacts: ['contacts', 'contact'],
  agenda: ['agenda'],
  pipeline: ['pipeline'],
  automation: ['automation'],
  estadisticas: ['estadisticas'],
  ajustes: ['ajustes', 'users', 'accounts', 'planes', 'marcas', 'sistema', 'plan', 'consumo', 'logs', 'password', 'integraciones'],
};

/** Opciones de Ajustes, agrupadas como un submenú (las de la plataforma solo las ve el superadministrador). */
function settingsGroups() {
  return [
    ['General', [['#/ajustes', 'Resumen', 'ajustes']]],
    ['Mi negocio', [
      ['#/automation/settings', 'Horario y avisos', 'automation/settings'],
      ['#/users', 'Mi equipo', 'users'],
      ['#/integraciones', 'Integraciones', 'integraciones'],
    ]],
    ['Cuenta', [
      !isSuper() ? ['#/plan', 'Mi plan y pagos', 'plan'] : null,
      ['#/consumo', 'Consumo de IA', 'consumo'],
      ['#/logs', 'Registros', 'logs'],
    ]],
    ['Personal', [['#/password', 'Mi perfil', 'password']]],
    isSuper() ? ['Plataforma', [
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

const closeNav = () => document.querySelector('.layout')?.classList.remove('nav-open');

export function shell(active, content) {
  refreshBell();
  const page = isAdmin() ? settingsPage(active) : null;
  const section = page ? 'ajustes' : Object.keys(SECTIONS).find((k) => SECTIONS[k].includes(active)) ?? active;
  const { user, account } = state.me;
  const item = (href, iconName, label, key) => h('a', { href, class: `nav-item${section === key ? ' active' : ''}`, 'aria-current': section === key ? 'page' : null, onclick: closeNav },
    icon(iconName), h('span', {}, label));

  const switcher = isSuper()
    ? h('label', { class: 'account-switch' },
        h('span', { class: 'sr-only' }, 'Perfil de negocio'),
        h('select', { id: 'profile-switch',
          onchange: (e) => {
            state.accountId = e.target.value; invalidateReads();
            if (location.hash.startsWith('#/logs?')) {
              const filters = new URLSearchParams(location.hash.split('?')[1]);
              filters.delete('account_id');
              history.replaceState(null, '', '#/logs' + (filters.size ? '?' + filters : ''));
            }
            try { localStorage.setItem('cp-account', state.accountId); } catch { /* */ }
            if (location.hash.startsWith('#/bot/') || location.hash.startsWith('#/channel/') || location.hash.startsWith('#/agentes/conexion/')) { location.hash = '#/agentes'; return; }
            render();
          },
        },
        h('option', { value: '' }, 'Todos los perfiles'),
        state.accounts.map((a) => h('option', { value: a.id, selected: a.id === state.accountId }, a.name + (a.active ? '' : ' (inactiva)')))))
    : h('div', { class: 'account-switch' }, h('strong', {}, account?.name || brand.name), h('span', {}, ROLE_LABEL[user.role]));

  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Menú principal' },
    h('div', { class: 'brand' }, brand.logo ? brandMark(28) : h('span', { class: 'brand-name' }, brand.name === 'Panel de Chatbots' ? 'Chatbots' : brand.name)),
    switcher,
    h('div', { class: 'nav-list' },
      isAdmin() ? item('#/agentes', 'bot', 'Agentes', 'agentes') : null,
      item('#/conversations', 'chat', 'Conversaciones', 'conversations'),
      item('#/contacts', 'contacts', 'Contactos', 'contacts'),
      item('#/agenda', 'calendar', 'Calendarios', 'agenda'),
      item('#/pipeline', 'pipeline', 'Oportunidades', 'pipeline'),
      isAdmin() ? item('#/automation', 'zap', 'Automatización', 'automation') : null,
      isAdmin() ? item('#/estadisticas', 'chart', 'Reportes', 'estadisticas') : null),
    h('div', { class: 'spacer' }),
    isAdmin() ? item('#/ajustes', 'settings', 'Ajustes', 'ajustes') : item('#/password', 'user', 'Mi perfil', 'ajustes'),
  );

  const initials = (user.name || user.email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const menu = h('div', { class: 'user-menu', hidden: true, role: 'menu' },
    h('div', { class: 'user-menu-head' }, h('strong', {}, user.name || user.email), h('span', { class: 'small muted' }, `${user.email} · ${ROLE_LABEL[user.role]}`)),
    h('a', { href: '#/password', role: 'menuitem' }, icon('user', 18), 'Mi perfil'),
    h('a', { href: '#', role: 'menuitem', onclick: async (e) => { e.preventDefault(); await api('POST', '/api/logout'); state.me = null; state.ux = []; window.dispatchEvent(new Event('sessionended')); invalidateReads(); resetBrand(); location.hash = '#/login'; } }, icon('logout', 18), 'Cerrar sesión'));
  const avatar = h('button', { class: 'avatar', type: 'button', 'aria-label': `Menú de ${user.name || user.email}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; avatar.setAttribute('aria-expanded', String(!menu.hidden)); } }, initials);
  const closeMenu = (e) => {
    if (!avatar.isConnected) return document.removeEventListener('click', closeMenu);
    if (!menu.hidden && !menu.contains(e.target)) { menu.hidden = true; avatar.setAttribute('aria-expanded', 'false'); }
  };
  document.addEventListener('click', closeMenu);

  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'icon-button nav-toggle', type: 'button', 'aria-label': 'Abrir el menú', onclick: () => document.querySelector('.layout').classList.add('nav-open') }, icon('menu')),
    h('div', { class: 'topbar-title' }, page ? 'Ajustes' : ''),
    h('div', { class: 'topbar-actions' },
      h('a', { class: 'icon-button', href: '/ayuda.html', target: '_blank', rel: 'noopener', 'aria-label': 'Ayuda', title: 'Ayuda' }, icon('help')),
      h('a', { class: `icon-button${active === 'notifications' ? ' active' : ''}`, href: '#/notifications', 'aria-label': 'Notificaciones', title: 'Notificaciones' }, icon('bell'), bell),
      h('div', { class: 'user-menu-wrap' }, avatar, menu)));

  const body = page ? h('div', { class: 'settings-layout' }, settingsNav(page), h('div', { class: 'settings-body' }, content)) : content;
  return h('div', { class: 'layout' },
    sidebar,
    h('div', { class: 'scrim', onclick: closeNav }),
    h('div', { class: 'content' }, topbar, h('main', { class: 'main' }, accountBanner(), body)));
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
  if (account.status === 'paused') {
    items.push(h('div', { class: 'banner danger' }, h('strong', {}, 'Tu cuenta está en pausa. '),
      'Tu asistente no está respondiendo ni enviando mensajes; tu configuración y tus conversaciones se conservan.',
      state.meta.billing_enabled && isAdmin() ? [' ', h('a', { class: 'btn primary', href: '#/plan' }, 'Activar mi plan')] : state.meta.support_contact ? [' Para activarla escribe a ', h('strong', {}, state.meta.support_contact), '.'] : ''));
  } else if (account.status === 'trial' && account.trial_ends_at) {
    const days = Math.max(0, Math.ceil((new Date(account.trial_ends_at) - Date.now()) / 86400000));
    items.push(h('div', { class: `banner ${days <= 3 ? 'warn' : ''}` },
      `Periodo de prueba: ${days === 0 ? 'termina hoy' : days === 1 ? 'queda 1 día' : `quedan ${days} días`}.`,
      state.meta.billing_enabled && isAdmin() ? [' ', h('a', { class: 'btn primary', href: '#/plan' }, 'Contratar ahora')] : state.meta.support_contact ? [' Para contratar escribe a ', h('strong', {}, state.meta.support_contact), '.'] : ''));
  }
  const here = location.hash.split('?')[0];
  if (state.wa && !state.wa.connected && isAdmin() && !['#/conectar', '#/inicio'].includes(here) && !here.startsWith('#/channel/')) {
    items.push(h('div', { class: 'banner warn' }, h('strong', {}, state.wa.has ? 'Tu WhatsApp no está conectado. ' : 'Aún no conectas tu WhatsApp. '),
      'Tu asistente no puede responder hasta que lo vincules. ', h('a', { class: 'btn primary', href: '#/agentes' }, 'Conectar desde mi agente')));
  }
  if (!user.email_verified_at && state.meta.require_email) {
    items.push(h('div', { class: 'banner warn' },
      `Confirma tu correo (${user.email}) con el enlace que te enviamos para poder conectar tu WhatsApp. `,
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); if (!(await run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace'))) return; } }, 'Reenviar correo')));
  }
  return items.length ? h('div', { class: 'stack', style: 'margin-bottom:16px' }, items) : null;
}

/** Cuenta propia con el asistente sin terminar: se abre "Primeros pasos" en lugar de la lista de chatbots. */
export function needsOnboarding() {
  const acc = state.me?.account;
  return !isSuper() && isAdmin() && acc && acc.signup_source === 'signup' && !acc.onboarding?.done;
}
