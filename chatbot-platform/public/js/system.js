import { api, confirmAction, field, fill, fmtDate, h, run, toast } from './core.js';
import { render } from './main.js';
import { configSection, functionalSection } from './system-config.js';

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
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Servidor'),
        h('p', { class: 'small' }, 'Versión: ', h('code', {}, sys.version)),
        h('p', { class: 'small' }, `Encendido hace ${dur(sys.uptime_seconds)} · memoria ${sys.memory_mb} MB`),
        h('p', { class: 'small' }, `Errores en 24 h: `, h('a', { href: '#/logs?level=error' }, String(sys.errors_24h))),
        h('p', { class: 'small muted' }, 'Para actualizar ejecuta ./riverrun update en el servidor.')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Clientes'),
        h('p', { class: 'small' }, 'Cuentas: ', sum(sys.accounts, 'status')),
        h('p', { class: 'small' }, 'WhatsApp: ', sum(sys.whatsapp, 'state')),
        h('p', { class: 'small' }, 'Suscripciones: ', sum(sys.subscriptions, 'status'))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Respaldos'),
        b ? [
          h('p', { class: 'small' }, b.ok ? h('span', { class: 'badge green' }, '✓ Último respaldo correcto') : h('span', { class: 'badge red' }, '✕ Falló el último intento'), ' ', b.verified ? h('span', { class: 'badge green' }, 'restauración probada') : null),
          h('p', { class: 'small' }, `Último correcto: ${b.last_success_at ? fmtDate(b.last_success_at) : 'nunca'} · ${b.size_bytes ? (b.size_bytes / 1048576).toFixed(1) + ' MB' : ''}`),
          h('p', { class: 'small' }, b.remote ? `Copia en la nube: ${b.remote_ok === false ? '✕ falló' : '✓ activa'}` : '⚠️ Solo hay copia en este servidor. Configura BACKUP_S3_* para guardarla fuera.'),
          b.error ? h('p', { class: 'small error' }, b.error) : null,
        ] : h('p', { class: 'small muted' }, 'Todavía no hay respaldos.')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Alertas'),
        h('p', { class: 'small' }, sys.alerts_configured.email ? '✓ Por correo (SUPERADMIN_EMAIL + SMTP)' : '✕ Por correo: falta SUPERADMIN_EMAIL o SMTP_URL'),
        h('p', { class: 'small' }, sys.alerts_configured.webhook ? '✓ Por webhook (Slack, Discord, ntfy…)' : '– Por webhook: opcional (ALERT_WEBHOOK_URL)'),
        h('p', { class: 'small' }, sys.alerts_configured.heartbeat ? '✓ Latido externo (HEARTBEAT_URL): si el servidor cae, el servicio externo avisa' : '✕ Latido externo: falta HEARTBEAT_URL (por ejemplo healthchecks.io); sin él nadie avisa si el servidor completo se cae'),
        !sys.alerts_configured.email && !sys.alerts_configured.webhook ? h('p', { class: 'banner danger', role: 'alert' }, 'Ninguna alerta sale del panel: si algo falla de noche, nadie se entera. Configura SMTP_URL o ALERT_WEBHOOK_URL.') : null,
        h('p', { class: 'small' }, sys.heartbeat_configured ? '✓ Latido externo activo' : '⚠️ Sin latido externo: si el servidor entero cae, nadie se entera. Configura HEARTBEAT_URL (healthchecks.io es gratis).'))));
  root.append(await zernioCard(), functionalSection(sys.functional), await configSection());
}

/** Una sola llave de Zernio para todas las cuentas: se pega aquí, se prueba y queda activa sin reiniciar. */
async function zernioCard() {
  const card = h('div', { class: 'card', id: 'zernio-key' });
  const draw = (s) => {
    const form = { api_key: '' };
    const input = h('input', { type: 'password', autocomplete: 'off', placeholder: s.source === 'panel' ? 'Pega una llave nueva para reemplazarla' : 'sk_…', oninput: (e) => (form.api_key = e.target.value) });
    const busy = async (button, fn) => { button.disabled = true; try { const r = await fn(); if (r) draw(r); } finally { button.disabled = false; } };
    fill(card,
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Redes sociales (Zernio)'),
        h('span', { class: `badge ${s.enabled ? 'green' : 'orange'}` }, s.enabled ? '✓ Activa' : 'Sin llave')),
      h('p', { class: 'small muted' }, 'Una sola llave para toda la plataforma: con ella cada negocio conecta Instagram, Facebook, Telegram, X, Bluesky, Reddit y WhatsApp Business desde su panel, con su propio perfil de Zernio. Los negocios nunca ven la llave.'),
      s.source === 'env' ? h('p', { class: 'small' }, `Definida en el servidor (ZERNIO_API_KEY), termina en …${s.hint}. Se administra en el .env.`)
        : s.source === 'panel' ? h('p', { class: 'small' }, `Guardada en el panel (cifrada), termina en …${s.hint}`, s.updated_at ? ` · ${fmtDate(s.updated_at)}` : '', '.')
          : h('p', { class: 'small' }, 'Crea una llave en zernio.com → Settings → API Keys y pégala aquí.'),
      s.enabled ? h('p', { class: 'small' }, `Cuentas con perfil de Zernio: ${s.accounts_with_profile} de ${s.accounts_total}`, s.creating_profiles ? ` (creando ${s.creating_profiles}…)` : '', ` · redes conectadas: ${s.connected_channels}`) : null,
      s.webhook ? h('p', { class: `small ${s.webhook.ok ? '' : 'error'}` }, s.webhook.ok ? '✓ Webhook registrado en Zernio: ' : '✕ No se pudo registrar el webhook: ', s.webhook.ok ? h('code', {}, s.webhook_url) : s.webhook.error) : null,
      s.source !== 'env' ? h('div', { class: 'row', style: 'align-items:flex-end' },
        field(s.source === 'panel' ? 'Reemplazar llave' : 'Llave de Zernio', input),
        h('button', { class: 'primary', onclick: (e) => busy(e.currentTarget, () => {
          if (!form.api_key.trim()) { input.focus(); return null; }
          return run(() => api('PUT', '/api/system/zernio', { api_key: form.api_key.trim() })).then((r) => {
            if (r) toast(r.webhook?.ok === false ? `Llave guardada, pero no se pudo registrar el webhook: ${r.webhook.error}` : 'Llave guardada y verificada', r.webhook?.ok === false);
            return r;
          });
        }) }, 'Guardar y probar')) : null,
      h('div', { class: 'row' },
        s.enabled ? h('button', { onclick: (e) => busy(e.currentTarget, () => run(() => api('POST', '/api/system/zernio/check'), 'Llave y webhook verificados')) }, 'Probar y reparar') : null,
        s.source === 'panel' ? h('button', { class: 'danger', onclick: (e) => busy(e.currentTarget, async () =>
          (await confirmAction('¿Quitar la llave de Zernio? Las redes sociales de todas las cuentas dejarán de recibir y enviar mensajes.')) ? run(() => api('DELETE', '/api/system/zernio'), 'Llave quitada') : null) }, 'Quitar llave') : null));
  };
  try { draw(await api('GET', '/api/system/zernio')); } catch (e) { fill(card, h('h2', { style: 'margin-top:0' }, 'Redes sociales (Zernio)'), h('p', { class: 'error' }, e.message)); }
  return card;
}
