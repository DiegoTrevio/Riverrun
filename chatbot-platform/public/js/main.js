import { $app, errorCard, fill, h, recordUX, state } from './core.js';
import { ensureBrand } from './brand.js';
import { loadWhatsappStatus } from './connect.js';
import { clearTimers, isAdmin, loadSession } from './session.js';
import { shell } from './shell.js';

/* ------------------------------ Router ------------------------------ */

window.addEventListener('hashchange', render);

render();

export async function render() {
  const start = performance.now();
  const nav = ++state.navigation;
  clearTimers();
  const current = () => nav === state.navigation;
  fill($app, h('main', { class: 'main loading-view', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, 'Cargando…'));
  const view = async (file, name, ...args) => { const module = await import(`./${file}.js`); if (current()) return module[name](...args); };
  const hash = location.hash.slice(1) || '/';
  const [pathPart, qs] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(qs || '');

  if (['login', 'registro', 'olvide', 'restablecer', 'verificar'].includes(parts[0])) await ensureBrand('host');
  if (!current()) return;
  if (parts[0] === 'login') return view('auth', 'renderLogin');
  if (parts[0] === 'registro') return view('auth', 'renderSignup');
  if (parts[0] === 'olvide') return view('auth', 'renderForgot');
  if (parts[0] === 'restablecer') return view('auth', 'renderReset', params.get('token') || '');
  if (parts[0] === 'verificar') return view('auth', 'renderVerify', params.get('token') || '');
  // Refresh profile and permissions on navigation; server-side reassignment also affects open sessions.
  try {
    await loadSession();
  } catch (error) {
    if (current() && error.message !== 'Sesión expirada') fill($app, h('main', { class: 'main' }, errorCard(error, render)));
    return;
  }
  if (!current()) return;
  await ensureBrand('mine');
  if (!current()) return;
  await loadWhatsappStatus();
  if (!current()) return;
  // Los agentes solo atienden conversaciones.
  if (!isAdmin() && !['conversations', 'conversation', 'password', 'agenda', 'notifications'].includes(parts[0])) {
    location.hash = '#/conversations';
    return;
  }
  const pending = h('p', { class: 'help', role: 'status' }, 'Cargando información…');
  const content = h('div', { 'aria-busy': 'true' }, pending);
  fill($app, shell(parts[0] || 'home', content));
  try {
    if (parts[0] === 'agentes' && parts[1] === 'conexion') await view('channels', 'viewChannel', content, parts[2]);
    else if (!parts.length || ['agentes', 'asistentes'].includes(parts[0])) await view('dashboard', 'viewDashboard', content, params);
    else if (parts[0] === 'inicio') await view('onboarding', 'viewOnboarding', content, parts[1]);
    else if (parts[0] === 'asistente' || parts[0] === 'probar') await view('dashboard', 'goMainBot', content, parts[0] === 'probar' ? 'probar' : 'conocimiento');
    else if (parts[0] === 'conectar') await view('agent-connections', 'goLegacyConnections', params);
    else if (parts[0] === 'ajustes') await view('dashboard', 'viewSettingsHub', content);
    else if (parts[0] === 'integraciones') await view('integrations', 'viewIntegrations', content, params);
    else if (parts[0] === 'marcas') await view('brandadmin', 'viewBrands', content);
    else if (parts[0] === 'sistema') await view('system', 'viewSystem', content);
    else if (parts[0] === 'plan') await view('billing', 'viewPlan', content, params);
    else if (parts[0] === 'planes') await view('billing', 'viewPlans', content);
    else if (parts[0] === 'estadisticas') await view('analytics', 'viewAnalytics', content, params);
    else if (parts[0] === 'consumo') await view('usage', 'viewUsage', content, params);
    else if (parts[0] === 'bot' && parts[2] === 'conexiones' && parts[3]) await view('channels', 'viewChannel', content, parts[3], parts[1]);
    else if (parts[0] === 'bot') await view('bot', 'viewBot', content, parts[1], parts[2] || 'general', params);
    else if (parts[0] === 'channels') await view('agent-connections', 'goLegacyConnections', params);
    else if (parts[0] === 'channel') await view('channels', 'viewChannel', content, parts[1]);
    else if (parts[0] === 'conversations') await view('conversations', 'viewConversations', content, params);
    else if (parts[0] === 'conversation') await view('conversations', 'viewConversation', content, parts[1]);
    else if (parts[0] === 'users') await view('admin', 'viewUsers', content);
    else if (parts[0] === 'accounts') await view('admin', 'viewAccounts', content);
    else if (parts[0] === 'logs') await view('logs', 'viewLogs', content, params);
    else if (parts[0] === 'password') await view('admin', 'viewPassword', content);
    else if (parts[0] === 'automation') await view('automation', 'viewAutomation', content, parts[1] || 'rules', parts[2]);
    else if (parts[0] === 'agenda') await view('agenda', 'viewAgenda', content, parts[1] || 'citas', params);
    else if (parts[0] === 'notifications') await view('admin', 'viewNotifications', content);
    else content.append(h('p', {}, 'Página no encontrada'));
    if (current()) {
      pending.remove(); content.removeAttribute('aria-busy');
      recordUX(`navigate:${parts[0] || 'agentes'}`, performance.now() - start, 'ok');
      const title = content.querySelector('h1');
      if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
      content.querySelectorAll('table').forEach((table) => { const labels = [...table.querySelectorAll('thead th')].map((th) => th.textContent); table.querySelectorAll('tbody tr').forEach((row) => [...row.children].forEach((td, i) => { if (labels[i]) td.dataset.label = labels[i]; })); });
    }
  } catch (e) {
    if (current()) { content.removeAttribute('aria-busy'); fill(content, errorCard(e, render)); }
  }
}
