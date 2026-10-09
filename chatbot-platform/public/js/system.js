import { api, fmtDate, h } from './core.js';
import { render } from './main.js';

/* ------------------------------ Sistema (superadmin) ------------------------------ */

const CHECK_BADGE = { ok: ['green', '✓ Bien'], warn: ['orange', '! Atención'], fail: ['red', '✕ Falla'], na: ['', '—'] };

export async function viewSystem(root) {
  const sys = await api('GET', '/api/system/status');
  const dur = (sec) => (sec > 86400 ? `${Math.floor(sec / 86400)} d ${Math.floor((sec % 86400) / 3600)} h` : sec > 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.floor(sec / 60)} min`);
  const b = sys.backup;
  const sum = (rows, k) => rows.map((r) => `${r.n} ${r[k]}`).join(' · ') || '—';
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Sistema'), h('button', { onclick: () => render() }, '↻ Actualizar')),
    h('div', { class: `banner ${sys.status === 'fail' ? 'danger' : sys.status === 'warn' ? 'warn' : 'ok'}` },
      sys.status === 'ok' ? 'Todo funciona correctamente.' : sys.status === 'warn' ? 'Funciona, pero hay algo que revisar.' : 'Hay un problema que necesita atención ahora.'),
    h('div', { class: 'card', style: 'margin-top:16px' },
      h('table', {}, h('tbody', {}, sys.checks.map((c) => h('tr', {},
        h('td', {}, h('strong', {}, c.label)),
        h('td', {}, h('span', { class: `badge ${CHECK_BADGE[c.status][0]}` }, CHECK_BADGE[c.status][1])),
        h('td', { class: 'small muted' }, c.detail)))))),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Servidor'),
        h('p', { class: 'small' }, 'Versión: ', h('code', {}, sys.version)),
        h('p', { class: 'small' }, `Encendido hace ${dur(sys.uptime_seconds)} · memoria ${sys.memory_mb} MB`),
        h('p', { class: 'small' }, `Errores en 24 h: `, h('a', { href: '#/logs?level=error' }, String(sys.errors_24h))),
        h('p', { class: 'small muted' }, 'Para actualizar ejecuta ./riverrun update en el servidor.')),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Clientes'),
        h('p', { class: 'small' }, 'Cuentas: ', sum(sys.accounts, 'status')),
        h('p', { class: 'small' }, 'WhatsApp: ', sum(sys.whatsapp, 'state')),
        h('p', { class: 'small' }, 'Suscripciones: ', sum(sys.subscriptions, 'status'))),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Respaldos'),
        b ? [
          h('p', { class: 'small' }, b.ok ? h('span', { class: 'badge green' }, '✓ Último respaldo correcto') : h('span', { class: 'badge red' }, '✕ Falló el último intento'), ' ', b.verified ? h('span', { class: 'badge green' }, 'restauración probada') : null),
          h('p', { class: 'small' }, `Último correcto: ${b.last_success_at ? fmtDate(b.last_success_at) : 'nunca'} · ${b.size_bytes ? (b.size_bytes / 1048576).toFixed(1) + ' MB' : ''}`),
          h('p', { class: 'small' }, b.remote ? `Copia en la nube: ${b.remote_ok === false ? '✕ falló' : '✓ activa'}` : '⚠️ Solo hay copia en este servidor. Configura BACKUP_S3_* para guardarla fuera.'),
          b.error ? h('p', { class: 'small error' }, b.error) : null,
        ] : h('p', { class: 'small muted' }, 'Todavía no hay respaldos.')),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Alertas'),
        h('p', { class: 'small' }, sys.alerts_configured.email ? '✓ Por correo (SUPERADMIN_EMAIL + SMTP)' : '✕ Por correo: falta SUPERADMIN_EMAIL o SMTP_URL'),
        h('p', { class: 'small' }, sys.alerts_configured.webhook ? '✓ Por webhook (Slack, Discord, ntfy…)' : '– Por webhook: opcional (ALERT_WEBHOOK_URL)'),
        h('p', { class: 'small' }, sys.heartbeat_configured ? '✓ Latido externo activo' : '⚠️ Sin latido externo: si el servidor entero cae, nadie se entera. Configura HEARTBEAT_URL (healthchecks.io es gratis).'))));
}
