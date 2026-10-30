import { $app, errorCard, fill, h, recordUX, state } from './core.js';
import { brand, ensureBrand } from './brand.js';
import { loadWhatsappStatus } from './connect.js';
import { clearTimers, copilotAvailable, isAdmin, isSuper, loadSession } from './session.js';
import { shell } from './shell.js';

/* ------------------------------ Router ------------------------------ */

/** Ya se cargó el Copiloto alguna vez (para quitarlo si la cuenta deja de tenerlo). */
let copilotLoaded = false;

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

  if (['login', 'registro', 'registro-google', 'invitacion', 'olvide', 'restablecer', 'verificar'].includes(parts[0])) await ensureBrand('host');
  if (!current()) return;
  if (parts[0] === 'login') return view('auth', 'renderLogin');
  if (parts[0] === 'registro') return view('auth', 'renderSignup', params);
  if (parts[0] === 'registro-google') return view('auth', 'renderGoogleSignup', params.get('token') || '');
  if (parts[0] === 'invitacion') return view('auth', 'renderInvite', params);
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
  // A budget notice identifies its profile; validate against the authorized selector before switching.
  if(parts[0]==='consumo'&&state.me?.user.role==='superadmin'&&params.get('account_id')){
    const accountId=params.get('account_id');
    if(!state.accounts.some(a=>a.id===accountId)){
      fill($app,h('main',{class:'main'},errorCard(new Error('Perfil no encontrado'),render)));return;
    }
    state.accountId=accountId;try{localStorage.setItem('cp-account',accountId);}catch{/* optional storage */}
  }
  await ensureBrand('mine');
  if (!current()) return;
  await loadWhatsappStatus();
  if (!current()) return;
  // Los agentes solo atienden conversaciones (y lo de sus clientes: contactos, agenda, oportunidades y cobros).
  if (!isAdmin() && !['conversations', 'conversation', 'contacts', 'contact', 'password', 'agenda', 'notifications', 'pipeline', 'comentarios', 'cobros'].includes(parts[0])) {
    location.hash = '#/conversations';
    return;
  }
  // Crear un agente tiene su propia página (antes era una tarjeta dentro de la lista).
  if (['agentes', 'asistentes'].includes(parts[0]) && !parts[1] && params.get('new') === '1') { location.replace('#/agentes/nuevo'); return; }
  const pending = h('p', { class: 'help', role: 'status' }, 'Cargando información…');
  const content = h('div', { 'aria-busy': 'true' }, pending);
  fill($app, shell(parts[0] || 'home', content));
  try {
    // El maestro con «Todos los perfiles»: lo que es de un perfil pide elegirlo (en vez de un error del servidor).
    if (isSuper() && !state.accountId && ['comentarios', 'publicaciones', 'cobros', 'estadisticas', 'integraciones', 'redes', 'datos-clientes'].includes(parts[0])) await view('admin', 'needAccount', content);
    else if (parts[0] === 'agentes' && parts[1] === 'conexion') await view('channels', 'viewChannel', content, parts[2]);
    else if (parts[0] === 'agentes' && parts[1] === 'nuevo') await view('agentwizard', 'viewNewAgent', content, params);
    else if (!parts.length || ['agentes', 'asistentes'].includes(parts[0])) await view('dashboard', 'viewDashboard', content, params, !parts.length);
    // «Empezar» (y los antiguos Primeros pasos): a lo que falta para que el agente responda.
    else if (parts[0] === 'empezar' || parts[0] === 'inicio') await view('agentstart', 'goStart', content);
    else if (parts[0] === 'bot' && parts[2] === 'empezar') await view('agentstart', 'viewAgentStart', content, parts[1]);
    else if (parts[0] === 'asistente' || parts[0] === 'probar') await view('dashboard', 'goMainBot', content, parts[0] === 'probar' ? 'probar' : 'conocimiento');
    else if (parts[0] === 'conectar-facebook') await view('meta', 'viewMetaConnect', content, parts[1] || '', params);
    else if (parts[0] === 'conectar') await view('agent-connections', 'goLegacyConnections', params);
    else if (parts[0] === 'ajustes') await view('dashboard', 'viewSettingsHub', content);
    else if (parts[0] === 'integraciones') await view('integrations', 'viewIntegrations', content, params);
    else if (parts[0] === 'datos-clientes') await view('contact-fields', 'viewContactFields', content);
    else if (parts[0] === 'marcas') await view('brandadmin', 'viewBrands', content);
    else if (parts[0] === 'sistema' && parts[1] === 'zernio') await view('zernio-admin', 'viewZernioAdmin', content);
    else if (parts[0] === 'sistema') await view('system', 'viewSystem', content);
    else if (parts[0] === 'redes' && parts[1] === 'whatsapp' && parts[2]) await view('wa-templates', 'viewWaTemplates', content, parts[2]);
    else if (parts[0] === 'redes') await view('social-accounts', 'viewSocialAccounts', content, params);
    else if (parts[0] === 'comentarios') await view('social-inbox', 'viewSocialInbox', content, params);
    else if (parts[0] === 'publicaciones') await view('social-posts', 'viewSocialPosts', content, parts[1], params);
    else if (parts[0] === 'plan') await view('billing', 'viewPlan', content, params);
    else if (parts[0] === 'planes') await view('billing', 'viewPlans', content);
    else if (parts[0] === 'cobros') await view('receivables', 'viewReceivables', content, params);
    else if (parts[0] === 'negocio') await view('business', 'viewBusiness', content);
    else if (parts[0] === 'estadisticas' && parts[1] === 'redes') await view('analytics', 'viewSocialStats', content, params);
    else if (parts[0] === 'estadisticas') await view('analytics', 'viewAnalytics', content, params);
    else if (parts[0] === 'consumo') await view('usage', 'viewUsage', content, params);
    else if (parts[0] === 'bot' && parts[2] === 'conexiones' && parts[3]) await view('channels', 'viewChannel', content, parts[3], parts[1]);
    else if (parts[0] === 'bot') await view('bot', 'viewBot', content, parts[1], parts[2] || 'general', params);
    else if (parts[0] === 'channels') await view('agent-connections', 'goLegacyConnections', params);
    else if (parts[0] === 'channel') await view('channels', 'viewChannel', content, parts[1]);
    else if (parts[0] === 'contacts') await view('contact-workspace', 'viewContacts', content, params);
    else if (parts[0] === 'contact') await view('contact-workspace', 'viewContact', content, parts[1]);
    else if (parts[0] === 'conversations') await view('conversations', 'viewInbox', content, params, null);
    else if (parts[0] === 'conversation') await view('conversations', 'viewInbox', content, params, parts[1]);
    else if (parts[0] === 'users') await view('admin', 'viewUsers', content);
    else if (parts[0] === 'accounts') await view('admin', 'viewAccounts', content);
    else if (parts[0] === 'logs') await view('logs', 'viewLogs', content, params);
    else if (parts[0] === 'password') await view('admin', 'viewPassword', content);
    else if (parts[0] === 'automation') await view('automation', 'viewAutomation', content, parts[1] || 'lienzo', parts[2]);
    else if (parts[0] === 'pipeline') await view('pipeline', 'viewPipeline', content, parts[1], parts[2]);
    else if (parts[0] === 'cotizaciones') await view('quotes', 'viewQuotes', content, parts[1] || 'precios', params);
    else if (parts[0] === 'agenda') await view('agenda', 'viewAgenda', content, parts[1] || 'citas', params);
    else if (parts[0] === 'notifications') await view('admin', 'viewNotifications', content, params);
    else content.append(h('p', {}, 'Página no encontrada'));
    if (current()) {
      pending.remove(); content.removeAttribute('aria-busy');
      recordUX(`navigate:${parts[0] || 'agentes'}`, performance.now() - start, 'ok');
      const title = content.querySelector('h1');
      // Una vista puede marcar dónde empieza (la bandeja: la conversación elegida, no el título de la lista).
      const first = content.querySelector('[data-focus]') || title;
      if (first) { first.tabIndex = -1; first.focus({ preventScroll: true }); }
      // La pestaña dice en qué página estás (también para quien tiene varias abiertas o usa lector de pantalla).
      document.title = title?.textContent.trim() ? `${title.textContent.trim()} · ${brand.name}` : brand.name;
      content.querySelectorAll('table').forEach((table) => { const labels = [...table.querySelectorAll('thead th')].map((th) => th.textContent); table.querySelectorAll('tbody tr').forEach((row) => [...row.children].forEach((td, i) => { if (labels[i]) td.dataset.label = labels[i]; })); });
    }
    // Copiloto: se monta (o se quita) según la cuenta y se entera de la página abierta.
    if (current() && (copilotAvailable() || copilotLoaded)) { copilotLoaded = true; import('./copilot.js').then((m) => m.syncCopilot()).catch(() => undefined); }
  } catch (e) {
    if (current()) { content.removeAttribute('aria-busy'); fill(content, errorCard(e, render)); }
  }
}
