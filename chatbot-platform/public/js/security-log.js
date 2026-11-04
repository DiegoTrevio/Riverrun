import { api, fill, fmtDate, h, select } from './core.js';

/* ------------------------------ Bitácora de seguridad (etapa 7) ------------------------------ */

/** Qué pasó, en palabras. Lo que no está aquí se muestra con su clave. */
const LABELS = {
  'login.ok': 'Entró al panel',
  'login.failed': 'Contraseña equivocada',
  'login.blocked': 'Acceso frenado por demasiados intentos',
  'mfa.failed': 'Código de verificación equivocado',
  'notice.password_changed': 'Cambió su contraseña',
  'notice.password_reset': 'Restableció su contraseña',
  'notice.mfa_enabled': 'Activó la verificación en dos pasos',
  'notice.mfa_changed': 'Cambió su app de verificación',
  'notice.mfa_reset': 'Le restablecieron la verificación en dos pasos',
  'notice.recovery_used': 'Entró con un código de recuperación',
  'notice.recovery_regenerated': 'Generó códigos de recuperación nuevos',
  'notice.mfa_locked': 'Verificación bloqueada por códigos equivocados',
  'notice.new_device': 'Entró desde un dispositivo nuevo',
  'notice.ownership_transferred': 'Transfirió la cuenta',
  'notice.ownership_received': 'Recibió la cuenta',
  'notice.email_changed': 'Cambió su correo',
  'notice.role_changed': 'Le cambiaron el rol',
  'notice.retention_scheduled': 'Programó el borrado automático de datos',
  'export.account': 'Descargó todos los datos de la cuenta',
  'export.contacts': 'Descargó los contactos (CSV)',
  'export.conversations': 'Descargó las conversaciones (CSV)',
  'export.messages': 'Descargó los mensajes (CSV)',
  'export.quotes': 'Descargó las cotizaciones (CSV)',
  'export.contact': 'Descargó los datos de un contacto',
  'contact.erased': 'Borró un contacto con su historial',
  'account.deleted': 'Se borró la cuenta',
  'apikey.created': 'Creó una llave de la API',
  'apikey.revoked': 'Revocó una llave de la API',
  'webhook_secret.rotated': 'Cambió el secreto de los webhooks',
};

const FILTERS = [
  ['', 'Todo'], ['login', 'Accesos'], ['mfa', 'Códigos equivocados'], ['notice', 'Cambios de seguridad'],
  ['export', 'Descargas de datos'], ['contact.erased', 'Contactos borrados'], ['apikey', 'Llaves de la API'],
];

const RISKY = /^(login\.failed|login\.blocked|mfa\.failed|notice\.mfa_locked|alert\.)/;

/**
 * La bitácora en una tarjeta: filtro por tipo, tabla y «Ver más». `superadmin`: la de toda la plataforma (con los avisos
 * de detección, la cuenta y la IP completa); si no, la de la cuenta (`accountQuery`, p. ej. "?account_id=…").
 */
export function securityCard({ superadmin = false, accountQuery = '' } = {}) {
  const card = h('div', { class: 'card', id: 'bitacora-seguridad' });
  const st = { kind: '', rows: [], done: false, error: '' };
  const base = superadmin ? '/api/system/security-events' : '/api/security-events';
  const url = (before) => {
    const q = new URLSearchParams(accountQuery.replace(/^\?/, ''));
    if (st.kind) q.set('kind', st.kind);
    if (before) q.set('before', String(before));
    q.set('limit', '50');
    return `${base}?${q}`;
  };
  const load = async (more = false) => {
    try {
      const rows = await api('GET', url(more ? st.rows.at(-1)?.id : 0));
      st.rows = more ? [...st.rows, ...rows] : rows;
      st.done = rows.length < 50;
      st.error = '';
    } catch (e) { st.error = e.message; }
    draw();
  };
  const filters = FILTERS.concat(superadmin ? [['alert', 'Avisos de detección']] : []);
  const draw = () => fill(card,
    h('div', { class: 'row between' },
      h('h2', { style: 'margin:0' }, superadmin ? 'Seguridad' : 'Actividad de seguridad'),
      h('label', { class: 'small' }, 'Ver ', select(st, 'kind', filters, () => load()))),
    h('p', { class: 'small muted' }, superadmin
      ? 'Accesos, cambios de seguridad, descargas y borrados de datos de todas las cuentas, y los avisos de detección que se mandaron. Se guarda un año, aunque la cuenta ya no exista.'
      : 'Quién entró, quién cambió algo de seguridad y quién descargó o borró datos de esta cuenta. Se guarda un año.'),
    st.error ? h('p', { class: 'error' }, st.error) : null,
    !st.rows.length && !st.error ? h('p', { class: 'muted small' }, 'Nada registrado todavía.') : null,
    st.rows.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Cuándo'), h('th', {}, 'Qué'), h('th', {}, 'Quién'), h('th', {}, 'Desde'), superadmin ? h('th', {}, 'Cuenta') : null)),
      h('tbody', {}, st.rows.map((r) => h('tr', {},
        h('td', { class: 'small' }, fmtDate(r.at)),
        h('td', {},
          RISKY.test(r.kind) ? h('span', { class: `badge ${r.kind.startsWith('alert.') ? 'red' : 'orange'}` }, r.kind.startsWith('alert.') ? 'Aviso' : 'Atención') : null, ' ',
          r.kind.startsWith('alert.') ? (r.details?.title || r.kind) : (LABELS[r.kind] ?? r.kind),
          r.target ? h('span', { class: 'small muted' }, ` · ${r.target}`) : null),
        h('td', { class: 'small' }, r.email || '—'),
        h('td', { class: 'small muted' }, [r.ip, r.user_agent].filter(Boolean).join(' · ') || '—'),
        superadmin ? h('td', { class: 'small' }, r.account_id ? h('code', { title: r.account_id }, r.account_id.slice(0, 8)) : '—') : null)))) : null,
    st.rows.length && !st.done ? h('button', { class: 'small', onclick: () => load(true) }, 'Ver más') : null);
  draw();
  void load();
  return card;
}
