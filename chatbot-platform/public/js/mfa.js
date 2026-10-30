/**
 * Verificación en dos pasos en el panel: escribir el código de la app (o uno de recuperación) después de la contraseña y,
 * la primera vez, configurar la app (QR, código y los 10 códigos de recuperación).
 */
import { publicCard } from './auth.js';
import { api, field, fill, h, run, state, text, toast } from './core.js';

/** A dónde sigue después del segundo paso: el pago del registro (si eligió plan) o el panel. */
function goNext() {
  let next = '#/';
  try {
    next = sessionStorage.getItem('after-mfa') || '#/';
    sessionStorage.removeItem('after-mfa');
  } catch { /* sin storage */ }
  state.me = null;
  if (/^https:\/\//.test(next)) location.href = next;
  else location.hash = next.startsWith('#/') ? next : '#/';
}

const codeInput = (f) => text(f, 'code', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 9 });

export async function renderMfaVerify() {
  let info;
  try { info = await api('GET', '/api/2fa/challenge'); } catch { return; } // sin reto: core lleva a entrar con el aviso
  if (info.purpose === 'enroll') { location.hash = '#/login/configurar'; return; }
  const f = { code: '', remember: false };
  let recovery = false;
  const slot = h('div');
  const draw = () => fill(slot, recovery
    ? field('Código de recuperación', text(f, 'code', { autocomplete: 'off', required: true, placeholder: 'xxxx-xxxx-xxxx' }), 'Cada código de recuperación sirve una sola vez.')
    : field('Código de 6 dígitos', codeInput(f), 'Ábrelo en tu app de autenticación.'));
  const toggle = h('button', { type: 'button', class: 'link-button', onclick: () => {
    recovery = !recovery;
    f.code = '';
    toggle.textContent = recovery ? 'Usar el código de la app' : 'Usar un código de recuperación';
    draw();
  } }, 'Usar un código de recuperación');
  draw();
  const submit = async (e) => {
    e.preventDefault();
    const r = await run(() => api('POST', '/api/login/2fa', info.superadmin ? { code: f.code } : f));
    if (!r) return;
    if (r.recovery_remaining !== undefined) toast(`Te quedan ${r.recovery_remaining} códigos de recuperación. Si perdiste tu teléfono, configura tu app otra vez desde Mi perfil.`);
    goNext();
  };
  publicCard('Verificación en dos pasos',
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Escribe el código que muestra tu app de autenticación.'),
    h('form', { class: 'stack', onsubmit: submit },
      slot,
      info.superadmin ? null : h('label', { class: 'check' },
        h('input', { type: 'checkbox', onchange: (e) => (f.remember = e.target.checked) }),
        ' Recordar este dispositivo 30 días'),
      h('button', { class: 'primary', type: 'submit' }, 'Entrar'),
      toggle,
      h('p', { class: 'small', style: 'margin:0' }, h('a', { href: '#/login' }, 'Entrar con otra cuenta'))));
}

export async function renderMfaEnroll() {
  let data;
  try { data = await api('GET', '/api/2fa/enroll'); } catch { return; }
  const f = { code: '' };
  const box = h('div', { class: 'stack' });
  publicCard('Activa la verificación en dos pasos', box);
  const showCodes = (codes) => {
    const proceed = h('button', { class: 'primary', type: 'button', disabled: true, onclick: goNext }, 'Continuar');
    const plain = `Códigos de recuperación de ${data.account}\nCada uno sirve una sola vez para entrar si no tienes tu teléfono.\n\n${codes.join('\n')}\n`;
    fill(box,
      h('h2', {}, 'Guarda tus códigos de recuperación'),
      h('p', {}, 'Si pierdes tu teléfono, entra con uno de estos códigos. Cada uno sirve una sola vez. Guárdalos en tu gestor de contraseñas o imprímelos: no los volveremos a mostrar.'),
      h('ul', { class: 'recovery-codes' }, ...codes.map((c) => h('li', {}, h('code', {}, c)))),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(plain).then(() => toast('Códigos copiados'), () => toast('No se pudieron copiar: descárgalos', true)) }, 'Copiar'),
        h('button', { type: 'button', onclick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob([plain], { type: 'text/plain' })), download: 'codigos-de-recuperacion.txt' });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } }, 'Descargar .txt')),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', onchange: (e) => (proceed.disabled = !e.target.checked) }),
        ' Ya los guardé en un lugar seguro'),
      proceed);
  };
  const submit = async (e) => {
    e.preventDefault();
    const r = await run(() => api('POST', '/api/2fa/enroll', f));
    if (r) showCodes(r.recovery_codes);
  };
  fill(box,
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Además de tu contraseña, para entrar usarás un código de una app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…). Así nadie entra a tu cuenta aunque sepa tu contraseña.'),
    h('h2', {}, '1. Escanea este código con tu app de autenticación'),
    h('img', { src: data.qr, alt: 'Código QR para tu app de autenticación', width: 200, height: 200, class: 'totp-qr' }),
    h('details', {},
      h('summary', {}, '¿No puedes escanearlo? Escribe esta clave'),
      h('p', {}, h('code', { 'data-totp-secret': '' }, data.secret.match(/.{1,4}/g).join(' ')))),
    h('h2', {}, '2. Escribe el código que muestra la app'),
    h('form', { class: 'stack', onsubmit: submit },
      field('Código de 6 dígitos', codeInput(f)),
      h('button', { class: 'primary', type: 'submit' }, 'Activar')));
}
