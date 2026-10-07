import { viewAccounts, viewNotifications, viewPassword, viewUsers } from './admin.js';
import { viewAgenda } from './agenda.js';
import { renderForgot, renderLogin, renderReset, renderSignup, renderVerify } from './auth.js';
import { viewAutomation } from './automation.js';
import { viewPlan, viewPlans } from './billing.js';
import { viewBot } from './bot.js';
import { viewChannel, viewChannels } from './channels.js';
import { viewConversation, viewConversations } from './conversations.js';
import { $app, fill, h } from './core.js';
import { ensureBrand } from './brand.js';
import { viewBrands } from './brandadmin.js';
import { viewIntegrations } from './integrations.js';
import { goMainBot, viewDashboard, viewSettingsHub } from './dashboard.js';
import { viewLogs } from './logs.js';
import { viewOnboarding } from './onboarding.js';
import { clearTimers, isAdmin, loadSession } from './session.js';
import { needsOnboarding, shell } from './shell.js';
import { viewSystem } from './system.js';
import { viewUsage } from './usage.js';

/* ------------------------------ Router ------------------------------ */

window.addEventListener('hashchange', render);

render();

export async function render() {
  clearTimers();
  const hash = location.hash.slice(1) || '/';
  const [pathPart, qs] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(qs || '');

  if (['login', 'registro', 'olvide', 'restablecer', 'verificar'].includes(parts[0])) await ensureBrand('host');
  if (parts[0] === 'login') return renderLogin();
  if (parts[0] === 'registro') return renderSignup();
  if (parts[0] === 'olvide') return renderForgot();
  if (parts[0] === 'restablecer') return renderReset(params.get('token') || '');
  if (parts[0] === 'verificar') return renderVerify(params.get('token') || '');
  // Refresh profile and permissions on navigation; server-side reassignment also affects open sessions.
  try {
    await loadSession();
  } catch {
    return;
  }
  await ensureBrand('mine');
  // Los agentes solo atienden conversaciones.
  if (!isAdmin() && !['conversations', 'conversation', 'password', 'agenda', 'notifications'].includes(parts[0])) {
    location.hash = '#/conversations';
    return;
  }
  const content = h('div');
  fill($app, shell(parts[0] || 'home', content));
  try {
    if (!parts.length && needsOnboarding()) location.hash = '#/inicio';
    else if (!parts.length || parts[0] === 'asistentes') await viewDashboard(content, params);
    else if (parts[0] === 'inicio') await viewOnboarding(content, parts[1]);
    else if (parts[0] === 'asistente' || parts[0] === 'probar') await goMainBot(content, parts[0] === 'probar' ? 'probar' : 'conocimiento');
    else if (parts[0] === 'ajustes') await viewSettingsHub(content);
    else if (parts[0] === 'integraciones') await viewIntegrations(content, params);
    else if (parts[0] === 'marcas') await viewBrands(content);
    else if (parts[0] === 'sistema') await viewSystem(content);
    else if (parts[0] === 'plan') await viewPlan(content, params);
    else if (parts[0] === 'planes') await viewPlans(content);
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
