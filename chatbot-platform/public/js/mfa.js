/**
 * Verificación en dos pasos en el panel: escribir el código de la app (o uno de recuperación) después de la contraseña,
 * la primera vez configurar la app (QR, código y los 10 códigos de recuperación) y, en Mi perfil, cambiar de app,
 * generar códigos nuevos y olvidar dispositivos recordados.
 */
import { publicCard } from './auth.js';
import { api, dialog, field, fill, fmtDate, h, run, state, text, toast } from './core.js';

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

/** Los códigos de recuperación con «Copiar» y «Descargar .txt». */
function recoveryCodesBlock(codes, account) {
  const plain = `Códigos de recuperación de ${account}\nCada uno sirve una sola vez para entrar si no tienes tu teléfono.\n\n${codes.join('\n')}\n`;
  return h('div', { class: 'stack' },
    h('ul', { class: 'recovery-codes' }, ...codes.map((c) => h('li', {}, h('code', {}, c)))),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(plain).then(() => toast('Códigos copiados'), () => toast('No se pudieron copiar: descárgalos', true)) }, 'Copiar'),
      h('button', { type: 'button', onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([plain], { type: 'text/plain' })), download: 'codigos-de-recuperacion.txt' });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Descargar .txt')));
}

/** El QR y la clave para escribirla a mano. */
const qrBlock = (data) => [
  h('img', { src: data.qr, alt: 'Código QR para tu app de autenticación', width: 200, height: 200, class: 'totp-qr' }),
  h('details', {},
    h('summary', {}, '¿No puedes escanearlo? Escribe esta clave'),
    h('p', {}, h('code', { 'data-totp-secret': '' }, data.secret.match(/.{1,4}/g).join(' ')))),
];

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
    if (r.recovery_remaining !== undefined) {
      // Entró sin su app: el panel le pide configurarla otra vez (Mi perfil, con el aviso fijo hasta que la cambie).
      toast(`Te quedan ${r.recovery_remaining} códigos de recuperación.`);
      try {
        sessionStorage.setItem('mfa-recovery', '1');
        if (!/^https:\/\//.test(sessionStorage.getItem('after-mfa') || '')) sessionStorage.setItem('after-mfa', '#/password'); // el pago del registro va primero
      } catch { /* sin storage */ }
    }
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
    fill(box,
      h('h2', {}, 'Guarda tus códigos de recuperación'),
      h('p', {}, 'Si pierdes tu teléfono, entra con uno de estos códigos. Cada uno sirve una sola vez. Guárdalos en tu gestor de contraseñas o imprímelos: no los volveremos a mostrar.'),
      recoveryCodesBlock(codes, data.account),
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
    ...qrBlock(data),
    h('h2', {}, '2. Escribe el código que muestra la app'),
    h('form', { class: 'stack', onsubmit: submit },
      field('Código de 6 dígitos', codeInput(f)),
      h('button', { class: 'primary', type: 'submit' }, 'Activar')));
}

/**
 * «Confirma que eres tú»: pide el código (o uno de recuperación) para una acción delicada. true si quedó confirmado.
 * Tres oportunidades; si la verificación quedó bloqueada, lo dice y no insiste.
 */
export async function stepUpDialog() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = { code: '' };
    const input = text(f, 'code', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true });
    const content = h('div', { class: 'stack' },
      h('p', {}, attempt ? 'Ese código no es correcto: espera al siguiente e inténtalo otra vez.' : 'Para hacer esto, escribe el código de tu app de autenticación (o uno de recuperación).'),
      field('Código de 6 dígitos', input));
    if (!(await dialog('Confirma que eres tú', content, 'Confirmar', () => input.reportValidity()))) return false;
    try {
      await api('POST', '/api/2fa/step-up', { code: f.code });
      return true;
    } catch (e) {
      if (e.status === 429) { toast(e.message, true); return false; }
    }
  }
  return false;
}

/** Antes de abrir algo que no pasa por api() (p. ej. una descarga): confirma si hace falta. */
export async function ensureRecentMfa() {
  const { recent } = await api('GET', '/api/2fa/recent');
  return recent || stepUpDialog();
}

/** «Cambiar de app»: escanea el QR nuevo y confirma con un código de la app nueva. true si quedó cambiada. */
async function changeAuthenticator() {
  const data = await run(() => api('POST', '/api/me/2fa/authenticator'));
  if (!data) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = { code: '' };
    const input = codeInput(f);
    const content = h('div', { class: 'stack' },
      h('p', {}, attempt ? 'Ese código no es correcto: escribe el que muestra la app nueva.' : 'Escanea este código con la app nueva. La que usas ahora sigue sirviendo hasta que confirmes.'),
      ...qrBlock(data),
      field('Código de 6 dígitos de la app nueva', input));
    if (!(await dialog('Cambiar de app', content, 'Cambiar de app', () => input.reportValidity()))) return false;
    try {
      await api('POST', '/api/me/2fa/authenticator/confirm', { code: f.code });
      try { sessionStorage.removeItem('mfa-recovery'); } catch { /* sin storage */ }
      toast('Listo: desde ahora entra con el código de la app nueva');
      return true;
    } catch (e) {
      if (e.status !== 400) { toast(e.message, true); return false; }
    }
  }
  return false;
}

/** Mi perfil → Verificación en dos pasos: la app, los códigos de recuperación que quedan y los dispositivos recordados. */
export function mfaSecurityCard() {
  const box = h('div', { class: 'stack' }, h('p', { class: 'help', role: 'status' }, 'Cargando…'));
  const draw = async () => {
    const d = await api('GET', '/api/me/security').catch((e) => ({ error: e.message }));
    if (d.error) return fill(box, h('p', { class: 'error' }, d.error));
    const left = d.recovery_remaining;
    let recovered = false;
    try { recovered = sessionStorage.getItem('mfa-recovery') === '1'; } catch { /* sin storage */ }
    fill(box,
      recovered ? h('p', { class: 'banner warn', role: 'status' }, 'Entraste con un código de recuperación. Si perdiste tu teléfono, pulsa «Cambiar de app» para configurar la app en el nuevo.') : null,
      h('p', {}, h('span', { class: 'badge green' }, 'Activa'), d.totp_enabled_at ? ` desde el ${fmtDate(d.totp_enabled_at)}.` : null, ' Entras con tu contraseña y el código de tu app de autenticación.'),
      h('div', { class: 'row' }, h('button', { onclick: async () => { if (await changeAuthenticator()) draw(); } }, 'Cambiar de app')),
      h('h3', {}, 'Códigos de recuperación'),
      left <= 2 ? h('p', { class: 'banner warn', role: 'status' }, 'Te quedan pocos códigos de recuperación. Genera nuevos para poder entrar si pierdes tu teléfono.') : null,
      h('p', {}, left === 1 ? 'Te queda 1 código de recuperación.' : `Te quedan ${left} códigos de recuperación.`),
      h('div', { class: 'row' }, h('button', { onclick: async () => {
        if (!(await dialog('Generar códigos nuevos', h('p', {}, 'Los códigos que tienes ahora dejarán de servir.'), 'Generar códigos nuevos'))) return;
        const r = await run(() => api('POST', '/api/me/2fa/recovery-codes'));
        if (!r) return;
        await dialog('Tus códigos nuevos', h('div', { class: 'stack' },
          h('p', {}, 'Cada uno sirve una sola vez. Guárdalos en tu gestor de contraseñas o imprímelos: no los volveremos a mostrar.'),
          recoveryCodesBlock(r.recovery_codes, state.me.user.email)), 'Ya los guardé');
        draw();
      } }, 'Generar códigos nuevos')),
      h('h3', {}, 'Dispositivos recordados'),
      d.devices.length ? h('table', { class: 'responsive-table' },
        h('thead', {}, h('tr', {}, ...['Dispositivo', 'Último uso', 'Recordado hasta', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...d.devices.map((dev) => h('tr', {},
          h('td', { 'data-label': 'Dispositivo' }, h('strong', {}, dev.device)),
          h('td', { 'data-label': 'Último uso' }, fmtDate(dev.last_seen_at)),
          h('td', { 'data-label': 'Recordado hasta' }, fmtDate(dev.trusted_until)),
          h('td', {}, h('button', { class: 'small', 'aria-label': `Olvidar ${dev.device}`, onclick: async () => {
            if (await run(() => api('DELETE', `/api/me/devices/${dev.id}`), 'Dispositivo olvidado: te pedirá el código')) draw();
          } }, 'Olvidar')))))) : h('p', { class: 'muted' }, 'Ninguno. Al entrar puedes marcar «Recordar este dispositivo 30 días» para no escribir el código en ese navegador.'));
  };
  draw();
  return box;
}
