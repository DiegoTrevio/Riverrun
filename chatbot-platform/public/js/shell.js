import { brand, brandMark, resetBrand } from './brand.js';
import { api, h, invalidateReads, run, state } from './core.js';
import { render } from './main.js';
import { ROLE_LABEL, isAdmin, isSuper } from './session.js';

const bell = h('span', { class: 'badge red', hidden: true });

export async function refreshBell() {
  try {
    const n = await api('GET', '/api/notifications?limit=1');
    bell.textContent = n.unread;
    bell.hidden = !n.unread;
  } catch { /* sin sesión */ }
}

setInterval(() => { if (state.me && !document.hidden) refreshBell(); }, 20000);

/** Menú simple (por defecto para quien administra su propia cuenta): lo cotidiano en seis opciones; el resto, en Ajustes. */
const isAdvanced = () => { try { return localStorage.getItem('cp-advanced') === '1'; } catch { return false; } };

const setAdvanced = (on) => { try { localStorage.setItem('cp-advanced', on ? '1' : '0'); } catch { /* sin storage */ } };

function simpleLinks(link) {
  return [
    link('#/agentes', '🤖 Agentes', 'agentes'),
    link('#/conversations', '💬 Conversaciones', 'conversations'),
    link('#/agenda', '📅 Agenda', 'agenda'),
    link('#/ajustes', '⚙️ Ajustes', 'ajustes'),
  ];
}

export function shell(active, content) {
  refreshBell();
  if (['home', 'asistentes', 'asistente', 'bot', 'channels', 'channel', 'conectar', 'inicio', 'probar'].includes(active)) active = 'agentes';
  const simple = isAdmin() && !isSuper() && !isAdvanced();
  const link = (href, label, key) => h('a', { href, class: active === key ? 'active' : '', 'aria-current': active === key ? 'page' : null }, label);
  const navGroup = (label, keys, links) => h('details', { class: 'nav-group', open: keys.includes(active) },
    h('summary', { class: keys.includes(active) ? 'active' : '' }, label, label === 'Conversaciones' ? [' ', bell] : null), h('div', {}, links));
  const { user, account } = state.me;
  const switcher = isSuper()
    ? h('div', { class: 'account-switch' },
        h('label', { class: 'small muted', for: 'profile-switch' }, 'Perfil'),
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
    : h('div', { class: 'account-switch small muted' }, account?.name);
  return h('div', { class: 'layout' },
    h('nav', { class: 'sidebar' },
      h('div', { class: 'brand' }, brand.logo ? brandMark(32) : `💬 ${brand.name === 'Panel de Chatbots' ? 'Chatbots' : brand.name}`,
        simple ? h('a', { href: '#/notifications', class: 'notifications', 'aria-label': 'Notificaciones' }, '🔔 ', bell) : null,
        h('button', { class: 'nav-toggle', type: 'button', 'aria-label': 'Abrir o cerrar el menú', 'aria-expanded': 'false', onclick: (e) => { const open = e.currentTarget.closest('.layout').classList.toggle('nav-open'); e.currentTarget.setAttribute('aria-expanded', String(open)); } }, '☰ Menú')),
      switcher,
      simple ? simpleLinks(link) : [
      isAdmin() ? link('#/agentes', '🤖 Agentes', 'agentes') : null,
      navGroup('Conversaciones', ['conversations', 'conversation', 'notifications'], [
        link('#/conversations', 'Bandeja de entrada', 'conversations'),
        h('a', { href: '#/notifications', class: active === 'notifications' ? 'active' : '' }, 'Notificaciones'),
      ]),
      navGroup('Agenda y automatización', ['agenda', 'automation', 'estadisticas'], [
        link('#/agenda', 'Agenda', 'agenda'),
        isAdmin() ? link('#/automation', 'Automatización', 'automation') : null,
        isAdmin() ? link('#/estadisticas', 'Estadísticas', 'estadisticas') : null,
      ]),
      isAdmin() ? navGroup('Configuración', ['users', 'accounts', 'planes', 'sistema', 'plan', 'consumo', 'logs', 'password'], [
        link('#/users', 'Usuarios', 'users'),
        isSuper() ? link('#/accounts', 'Perfiles', 'accounts') : null,
        isSuper() ? link('#/planes', 'Planes y cobro', 'planes') : null,
        isSuper() ? link('#/marcas', 'Marca blanca', 'marcas') : null,
        isSuper() ? link('#/sistema', 'Sistema', 'sistema') : null,
        !isSuper() ? link('#/plan', 'Mi plan y pagos', 'plan') : null,
        link('#/consumo', 'Consumo de IA', 'consumo'),
        link('#/logs', 'Registros', 'logs'),
      ]) : null,
      ],
      h('div', { class: 'spacer' }),
      h('div', { class: 'small muted', style: 'padding:4px 10px' }, user.name || user.email, h('br'), ROLE_LABEL[user.role]),
      h('a', { href: '/ayuda.html', target: '_blank', rel: 'noopener' }, '❓ Ayuda'),
      link('#/password', 'Mi perfil', 'password'),
      isAdmin() && !isSuper() ? h('a', { href: '#', class: 'small muted', onclick: (e) => { e.preventDefault(); setAdvanced(!isAdvanced()); render(); } }, isAdvanced() ? '☰ Menú simple' : '☰ Mostrar todas las opciones') : null,
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/api/logout'); state.me = null; state.ux = []; window.dispatchEvent(new Event('sessionended')); invalidateReads(); resetBrand(); location.hash = '#/login'; } }, 'Cerrar sesión'),
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
      state.meta.billing_enabled && isAdmin() ? [' ', h('a', { class: 'btn primary', href: '#/plan' }, 'Reactivar mi plan')] : state.meta.support_contact ? [' Para activarla escribe a ', h('strong', {}, state.meta.support_contact), '.'] : ''));
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
