import { brand, brandMark } from './brand.js';
import { limitsText, per, planPrice, totalText } from './billing.js';
import { $app, api, field, fill, h, run, select, state, text, toast } from './core.js';

const GOOGLE_MSG = {
  cancelado: 'Cancelaste el acceso con Google.',
  error: 'No se pudo iniciar sesión con Google. Intenta de nuevo.',
  'sin-correo': 'Google no confirmó tu correo.',
  desactivada: 'Esta cuenta está desactivada.',
  'solo-contrasena': 'Esta cuenta solo entra con correo y contraseña.',
  'sin-cuenta': 'No hay una cuenta con ese correo y el registro está cerrado.',
  demasiados: 'Demasiados intentos, espera un poco.',
  'correo-temporal': 'Usa un correo permanente de tu negocio: no aceptamos correos temporales.',
  off: 'El acceso con Google no está activado.',
};

export function renderLogin() {
  const flash = new URLSearchParams((location.hash.split('?')[1] || '')).get('google');
  if (flash && GOOGLE_MSG[flash]) setTimeout(() => toast(GOOGLE_MSG[flash], true), 0);
  const f = { email: '', password: '' };
  const signupLink = h('p', { class: 'small', style: 'margin-bottom:0' });
  const googleSlot = h('div', {});
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() => api('POST', '/api/login', f));
    if (ok) { state.me = null; location.hash = '#/'; }
  };
  fill($app,
    h('form', { class: 'card login', onsubmit: submit },
      brand.logo ? h('div', { style: 'text-align:center;margin-bottom:8px' }, brandMark(48)) : null,
      h('h1', {}, brand.name),
      field('Correo', text(f, 'email', { type: 'email', autocomplete: 'username', required: true, placeholder: 'tu@correo.com' })),
      field('Contraseña', text(f, 'password', { type: 'password', autocomplete: 'current-password', required: true })),
      h('button', { class: 'primary', type: 'submit' }, 'Entrar'),
      h('p', { class: 'small', style: 'margin-bottom:0' }, h('a', { href: '#/olvide' }, '¿Olvidaste tu contraseña?')),
      signupLink,
      googleSlot,
    ),
  );
  api('GET', '/api/signup/info').then((i) => {
    const trial = i.trial_days > 0;
    if (i.google_login) fill(googleSlot, h('a', { class: 'btn', href: '/oauth/google/login', style: 'display:block;text-align:center;margin-top:12px' }, 'Continuar con Google'), h('p', { class: 'muted small' }, trial ? 'Si aún no tienes cuenta, la creas con tu prueba gratuita después de aceptar los términos del servicio.' : 'Si aún no tienes cuenta, la creas después de aceptar los términos del servicio (la activas al contratar tu plan).'));
    if (i.enabled) fill(signupLink, '¿Aún no tienes cuenta? ', h('a', { href: '#/registro' }, trial ? `Crea una gratis (${i.trial_days} días de prueba)` : 'Crea tu cuenta'));
  }).catch(() => undefined);
}

/* ------------------------------ Registro y recuperación (públicas) ------------------------------ */

function publicCard(title, ...kids) {
  fill($app, h('div', { class: 'card login', style: 'max-width:440px' }, h('h1', {}, title), kids));
}

/** Casilla de aceptación de términos y aviso de privacidad (se guarda como constancia al crear la cuenta). */
function termsCheck(info, f) {
  return h('label', { class: 'check small' }, h('input', { type: 'checkbox', onchange: (e) => (f.accept_terms = e.target.checked) }),
    [info.terms_url ? ['Acepto los ', h('a', { href: info.terms_url, target: '_blank', rel: 'noopener' }, 'términos del servicio')] : 'Acepto los términos del servicio',
      info.privacy_url ? [' y el ', h('a', { href: info.privacy_url, target: '_blank', rel: 'noopener' }, 'aviso de privacidad')] : '',
      '. Entiendo que WhatsApp se conecta como "dispositivo vinculado" (no es la API oficial) y que los envíos masivos pueden provocar el bloqueo del número.']);
}

/** Captcha de Cloudflare (solo si el servidor lo activa): guarda su respuesta en f.turnstile_token. */
function captcha(siteKey, f) {
  if (!siteKey) return null;
  const box = h('div', { class: 'captcha' });
  const draw = () => window.turnstile.render(box, { sitekey: siteKey, language: 'es', callback: (t) => (f.turnstile_token = t), 'expired-callback': () => (f.turnstile_token = '') });
  if (window.turnstile) setTimeout(draw, 0);
  else {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = draw;
    document.head.append(s);
  }
  return box;
}

/** Quien entra por primera vez con Google: acepta los términos y nombra su negocio antes de crear la cuenta. */
export async function renderGoogleSignup(token) {
  const navigation = state.navigation;
  let info;
  try {
    info = await api('GET', `/api/signup/google?token=${encodeURIComponent(token)}`);
  } catch (e) {
    if (navigation !== state.navigation) return;
    return publicCard('Registro con Google', h('p', {}, e?.message || 'El enlace de registro venció.'), h('a', { class: 'btn primary', href: '/oauth/google/login' }, 'Volver a entrar con Google'));
  }
  if (navigation !== state.navigation) return;
  const f = { token, company: info.name ? `Negocio de ${info.name}` : '', business_type: 'otro', accept_terms: false };
  let sending = false;
  const button = h('button', { class: 'primary', type: 'submit' }, 'Crear mi cuenta');
  const submit = async (e) => {
    e.preventDefault();
    if (sending) return;
    if (!f.accept_terms) return toast('Acepta los términos para continuar', true);
    sending = true;
    button.disabled = true;
    const r = await run(() => api('POST', '/api/signup/google', f));
    if (!r) { sending = false; button.disabled = false; return; }
    state.me = null;
    location.hash = '#/agentes/nuevo';
  };
  publicCard('Termina tu registro',
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Entraste con Google como ', h('strong', {}, info.email), '. Solo falta el nombre de tu negocio y aceptar los términos.'),
    h('form', { class: 'stack', onsubmit: submit },
      field('Nombre de tu negocio', text(f, 'company', { required: true, autocomplete: 'organization' })),
      field('Tipo de negocio', select(f, 'business_type', info.business_types.map((b) => [b.key, b.label]))),
      termsCheck(info, f),
      button,
      h('p', { class: 'small', style: 'margin:0' }, '¿No eres tú? ', h('a', { href: '#/login' }, 'Volver'))));
}

/** Aceptar una invitación de equipo: con el enlace del correo (elige contraseña) o tras entrar con Google. */
export async function renderInvite(params) {
  const navigation = state.navigation;
  const token = params.get('token') || '';
  const google = params.get('google') || '';
  const q = google ? `google=${encodeURIComponent(google)}` : `token=${encodeURIComponent(token)}`;
  let info;
  try {
    info = await api('GET', `/api/invitation?${q}`);
  } catch (e) {
    if (navigation !== state.navigation) return;
    return publicCard('Invitación', h('p', {}, e?.message || 'Esta invitación no es válida.'), h('a', { class: 'btn primary', href: '#/login' }, 'Iniciar sesión'));
  }
  if (navigation !== state.navigation) return;
  const f = { ...(google ? { google } : { token }), name: info.name || '', password: '', confirm: '', accept_terms: false };
  let sending = false;
  const button = h('button', { class: 'primary', type: 'submit' }, google ? 'Unirme con Google' : 'Unirme al equipo');
  const submit = async (e) => {
    e.preventDefault();
    if (sending) return;
    if (!google && f.password !== f.confirm) return toast('Las contraseñas no coinciden', true);
    if (!f.accept_terms) return toast('Acepta los términos para continuar', true);
    sending = true;
    button.disabled = true;
    const { confirm: _c, ...body } = f;
    const r = await run(() => api('POST', '/api/invitation/accept', google ? { ...body, password: undefined } : body));
    if (!r) { sending = false; button.disabled = false; return; }
    state.me = null;
    location.hash = '#/';
  };
  const role = info.role === 'admin' ? 'administrador' : 'agente';
  publicCard(`Únete a ${info.account}`,
    h('p', { class: 'muted', style: 'margin-top:0' }, info.invited_by ? `${info.invited_by} te invitó como ${role}. ` : `Te invitaron como ${role}. `,
      google ? ['Entraste con Google como ', h('strong', {}, info.email), '.'] : ['Tu acceso será con ', h('strong', {}, info.email), '.']),
    h('form', { class: 'stack', onsubmit: submit },
      field('Tu nombre', text(f, 'name', { required: true, autocomplete: 'name' })),
      google ? null : field('Elige tu contraseña', text(f, 'password', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true }), 'Mínimo 8 caracteres.'),
      google ? null : field('Repítela', text(f, 'confirm', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
      termsCheck(info, f),
      button,
      info.google_login ? h('a', { class: 'btn', href: '/oauth/google/login', style: 'display:block;text-align:center' }, 'Unirme con Google') : null,
      h('p', { class: 'small', style: 'margin:0' }, '¿Ya tienes cuenta? ', h('a', { href: '#/login' }, 'Inicia sesión'))));
}

/** Elegir plan al registrarse: prueba gratis (si hay) o un plan que se paga al crear la cuenta. */
function planPicker(info, f, onChange) {
  const box = h('div');
  const method = h('div');
  const option = (value, title, price, help) => h('label', { class: 'check plan-option' },
    h('input', { type: 'radio', name: 'signup-plan', value, checked: f.plan === value, onchange: () => { f.plan = value; f.provider = ''; drawMethod(); onChange(); } }),
    h('span', {}, h('strong', {}, title), help ? h('div', { class: 'small muted' }, help) : null),
    price ? h('span', { class: 'plan-price' }, price) : null);
  const drawMethod = () => {
    const providers = info.plans.find((p) => p.key === f.plan)?.providers ?? [];
    if (!f.provider || !providers.some((p) => p.name === f.provider)) f.provider = providers[0]?.name ?? '';
    fill(method, providers.length > 1
      ? field('Forma de pago', h('div', {}, providers.map((p) => h('label', { class: 'check', style: 'margin:4px 0' },
        h('input', { type: 'radio', name: 'signup-provider', value: p.name, checked: f.provider === p.name, onchange: () => { f.provider = p.name; } }), p.label))))
      : null);
  };
  fill(box,
    field('Tu plan', h('div', {},
      info.trial_days > 0 ? option('', `Probar gratis ${info.trial_days} ${info.trial_days === 1 ? 'día' : 'días'}`, '', 'Sin tarjeta. Contratas cuando quieras desde tu panel.') : null,
      info.plans.map((p) => option(p.key, p.name, `${planPrice(p)} / ${per(p)}`, [p.description, limitsText(p.limits), totalText(p)].filter(Boolean).join(' · ') || 'Sin límites de uso')))),
    method);
  drawMethod();
  return box;
}

export async function renderSignup(params = new URLSearchParams()) {
  const navigation = state.navigation;
  let info;
  try { info = await api('GET', '/api/signup/info'); } catch { info = { enabled: false, business_types: [], plans: [] }; }
  if (navigation !== state.navigation) return;
  if (!info.enabled) return publicCard('Registro cerrado', h('p', {}, 'Por ahora el registro no está disponible.'), h('a', { href: '#/login' }, 'Iniciar sesión'));
  info.plans = info.plans || [];
  const trial = info.trial_days > 0;
  // Un enlace desde tu página de precios puede traer el plan elegido: #/registro?plan=pro
  const wanted = info.plans.find((p) => p.key === params.get('plan'))?.key;
  const f = { name: '', company: '', business_type: 'otro', email: '', password: '', phone: '', accept_terms: false, website: '', plan: wanted || (trial ? '' : info.plans[0]?.key || ''), provider: '' };
  const button = h('button', { class: 'primary', type: 'submit' });
  const label = () => (button.textContent = f.plan ? 'Crear mi cuenta y pagar' : 'Crear mi cuenta');
  label();
  let sending = false;
  const submit = async (e) => {
    e.preventDefault();
    if (sending) return;
    if (!f.accept_terms) return toast('Acepta los términos para continuar', true);
    const { plan, provider, ...rest } = f;
    sending = true;
    button.disabled = true;
    const r = await run(() => api('POST', '/api/signup', { ...rest, ...(plan ? { plan, ...(provider ? { provider } : {}) } : {}) }));
    if (!r) { sending = false; button.disabled = false; return; }
    state.me = null;
    if (r.checkout_url) { button.textContent = 'Abriendo el pago seguro…'; location.href = r.checkout_url; return; }
    if (r.checkout_error) { toast(r.checkout_error, true); location.hash = `#/plan?plan=${encodeURIComponent(plan)}`; return; }
    location.hash = '#/agentes/nuevo';
  };
  const intro = info.plans.length
    ? (trial ? `Prueba gratis ${info.trial_days} días o contrata tu plan desde hoy.` : 'Crea tu cuenta y activa tu plan en un solo paso.')
    : (trial ? `Prueba gratis ${info.trial_days} días.` : `Crea tu cuenta; tu asistente se activa al contratar tu plan${info.support_contact ? ` (escríbenos a ${info.support_contact})` : ''}.`);
  publicCard('Crea tu asistente',
    h('p', { class: 'muted', style: 'margin-top:0' }, `${intro} En unos minutos tu asistente responde por WhatsApp.`),
    h('form', { class: 'stack', onsubmit: submit },
      field('Tu nombre', text(f, 'name', { required: true, autocomplete: 'name' })),
      field('Nombre de tu negocio', text(f, 'company', { placeholder: 'Clínica Sonrisa', required: true, autocomplete: 'organization' })),
      field('Tipo de negocio', select(f, 'business_type', info.business_types.map((b) => [b.key, b.label]))),
      field('Correo', text(f, 'email', { type: 'email', required: true, autocomplete: 'email', placeholder: 'tu@negocio.com' }), 'Te enviaremos un enlace para confirmarlo.'),
      field('Contraseña', text(f, 'password', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true }), 'Mínimo 8 caracteres.'),
      field('WhatsApp para avisos (opcional)', text(f, 'phone', { type: 'tel', autocomplete: 'tel', placeholder: '5215512345678' }), 'Ahí te avisamos cuando un cliente pida hablar con una persona.'),
      info.plans.length ? planPicker(info, f, label) : null,
      info.plans.length ? h('p', { class: 'muted small', style: 'margin:0' }, 'Si eliges un plan, al crear tu cuenta pasas a la página segura de pago (Stripe o Mercado Pago); nosotros nunca vemos tu tarjeta. Se renueva cada mes y puedes cancelar cuando quieras.') : null,
      // Campo trampa para bots: oculto para las personas.
      h('div', { style: 'position:absolute;left:-9999px', 'aria-hidden': 'true' }, h('input', { tabindex: '-1', autocomplete: 'off', oninput: (e) => (f.website = e.target.value) })),
      termsCheck(info, f),
      captcha(info.turnstile_site_key, f),
      button,
      h('p', { class: 'small', style: 'margin:0' }, '¿Ya tienes cuenta? ', h('a', { href: '#/login' }, 'Inicia sesión'),
        info.plans.length ? [' · ', h('a', { href: '/precios' }, 'Ver precios y planes')] : null)));
}

export function renderForgot() {
  const f = { email: '' };
  const box = h('div');
  publicCard('Recuperar contraseña', box);
  fill(box, h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const r = await run(() => api('POST', '/api/forgot-password', f));
    if (r) fill(box, h('p', {}, 'Si el correo está registrado, te enviamos un enlace para elegir una contraseña nueva. Vence en 1 hora.'), h('a', { href: '#/login' }, 'Volver a iniciar sesión'));
  } },
    field('Correo', text(f, 'email', { type: 'email', required: true, autocomplete: 'email' })),
    h('button', { class: 'primary', type: 'submit' }, 'Enviar enlace'),
    h('a', { class: 'small', href: '#/login' }, 'Volver')));
}

export function renderReset(token) {
  const f = { token, password: '', confirm: '' };
  const box = h('div');
  publicCard('Nueva contraseña', box);
  if (!token) return fill(box, h('p', {}, 'El enlace no es válido.'), h('a', { href: '#/olvide' }, 'Pedir uno nuevo'));
  fill(box, h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    if (f.password !== f.confirm) return toast('Las contraseñas no coinciden', true);
    const r = await run(() => api('POST', '/api/reset-password', { token: f.token, password: f.password }));
    if (r) fill(box, h('p', {}, 'Listo, ya puedes entrar con tu contraseña nueva.'), h('a', { class: 'btn primary', href: '#/login' }, 'Iniciar sesión'));
  } },
    field('Contraseña nueva', text(f, 'password', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true }), 'Mínimo 8 caracteres.'),
    field('Repítela', text(f, 'confirm', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
    h('button', { class: 'primary', type: 'submit' }, 'Guardar')));
}

export async function renderVerify(token) {
  const box = h('p', {}, 'Confirmando…');
  publicCard('Confirmar correo', box);
  try {
    await api('POST', '/api/verify-email', { token });
    state.me = null;
    fill(box, 'Tu correo quedó confirmado. ', h('a', { href: '#/empezar' }, 'Continuar →'));
  } catch (e) {
    fill(box, e.message, ' ', h('a', { href: '#/empezar' }, 'Ir al panel'));
  }
}
