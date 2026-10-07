import { $app, api, field, fill, h, run, select, state, text, toast } from './core.js';

export function renderLogin() {
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

export async function renderSignup() {
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

export function renderForgot() {
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

export function renderReset(token) {
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

export async function renderVerify(token) {
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
