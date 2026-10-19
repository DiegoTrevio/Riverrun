import { api, confirmAction, field, fill, fmtDate, h, run, toast } from './core.js';

/**
 * Zernio para el administrador de la plataforma: una sola llave, un perfil por negocio. Aquí se ve cada negocio con su
 * perfil y sus redes, se crean enlaces de conexión para mandarle al cliente, se revisa el webhook y lo que cuesta.
 */

const ICONS = { instagram: '📸', facebook: '📘', whatsapp: '🟢', telegram: '✈️', twitter: '𝕏', bluesky: '🦋', reddit: '👽', linkedin: '💼', tiktok: '🎵', youtube: '▶️', threads: '🧵', pinterest: '📌', googlebusiness: '🗺️' };
const STATUS_COLOR = { active: 'green', needs_reconnect: 'red', disconnected: 'red', stale: 'orange' };

/** Costo mensual estimado con la tabla pública de Zernio (2 cuentas gratis; luego por cuenta; mensajes salientes). */
function estimate(accounts, outbound) {
  let usd = 0;
  for (let i = 3; i <= accounts; i++) usd += i <= 10 ? 6 : i <= 100 ? 3 : 1;
  usd += Math.max(0, Math.ceil((outbound - 10_000) / 10_000));
  return usd;
}

export async function viewZernioAdmin(root) {
  root.append(h('a', { href: '#/sistema', class: 'breadcrumb' }, '← Sistema'), h('h1', {}, 'Zernio: negocios y redes'));
  const status = await api('GET', '/api/system/zernio');
  if (!root.isConnected) return;
  if (!status.enabled) {
    root.append(h('p', { class: 'banner warn' }, 'Primero guarda la llave de Zernio en Sistema → Redes sociales (Zernio).'));
    return;
  }
  const [tenants, budget, networks, health] = await Promise.all([
    api('GET', '/api/system/zernio/tenants'),
    api('GET', '/api/system/zernio/budget').catch(() => null),
    api('GET', '/api/meta').then((m) => m.social_capabilities || []).catch(() => []),
    api('GET', '/api/system/zernio/health').catch(() => null),
  ]);
  if (!root.isConnected) return;
  const label = (p) => networks.find((n) => n.id === p)?.label || p;
  const totalAccounts = tenants.reduce((s, t) => s + t.accounts.filter((a) => a.status !== 'disconnected').length, 0);
  const totalOutbound = tenants.reduce((s, t) => s + (t.outbound_month || 0), 0);

  const logs = h('div');
  const loadLogs = async () => {
    const r = await run(() => api('GET', '/api/system/zernio/webhook-logs'));
    if (!r) return;
    fill(logs, r.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Fecha'), h('th', {}, 'Evento'), h('th', {}, 'Resultado'), h('th', {}, ''))),
      h('tbody', {}, r.map((l) => h('tr', {},
        h('td', { class: 'small' }, l.created_at ? fmtDate(l.created_at) : '—'),
        h('td', { class: 'small' }, l.event || '—'),
        h('td', { class: 'small' }, l.ok ? '✓ Entregado' : `✕ ${l.status_code || ''} ${l.error || ''}`.trim()),
        h('td', {}, !l.ok && l.id ? h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/system/zernio/webhook-logs/${encodeURIComponent(l.id)}/redeliver`, { webhook_id: l.webhook_id }), 'Reenviado')) loadLogs(); } }, 'Reenviar') : null))))) : h('p', { class: 'muted small' }, 'Sin entregas registradas en los últimos 30 días.'));
  };

  const linkBox = (t) => {
    const out = h('div');
    const linkable = networks.filter((n) => n.flow === 'oauth');
    const choice = { platform: linkable[0]?.id || 'instagram' };
    return h('details', {}, h('summary', { class: 'small' }, 'Enlace de conexión'),
      h('div', { class: 'row', style: 'align-items:flex-end;margin-top:6px' },
        field('Red', h('select', { onchange: (e) => (choice.platform = e.target.value) }, linkable.map((n) => h('option', { value: n.id }, n.label)))),
        h('button', { class: 'small', onclick: async () => {
          const r = await run(() => api('POST', `/api/system/zernio/tenants/${t.account_id}/connect-link`, choice));
          if (!r) return;
          const input = h('input', { value: r.url, readonly: true, 'aria-label': 'Enlace para el cliente', style: 'width:100%' });
          fill(out, h('p', { class: 'small muted' }, `Válido hasta ${fmtDate(r.expires_at)}, de un solo uso. Mándaselo al cliente: inicia sesión en ${label(choice.platform)} y su cuenta queda en su perfil.`), input,
            h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(r.url); toast('Copiado'); } catch { input.select(); } } }, 'Copiar'));
        } }, 'Crear enlace')), out);
  };

  const row = (t) => h('tr', {},
    h('td', {}, h('strong', {}, t.name), t.active ? null : h('span', { class: 'badge orange' }, ' inactiva')),
    h('td', { class: 'small' }, t.profile_id ? '✓ Perfil' : h('span', { class: 'muted' }, 'Sin perfil')),
    h('td', {}, t.accounts.length ? t.accounts.map((a) => h('span', { class: `badge ${STATUS_COLOR[a.status] || ''}`, style: 'margin:2px', title: `${label(a.platform)} · ${a.status}` },
      ICONS[a.platform] || '🔗', ' ', a.username ? `@${a.username}` : label(a.platform))) : h('span', { class: 'muted small' }, '—')),
    h('td', { class: 'num' }, (t.outbound_month || 0).toLocaleString('es-MX')),
    h('td', {}, h('div', { class: 'stack' },
      h('div', { class: 'row' },
        !t.profile_id ? h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/system/zernio/tenants/${t.account_id}/profile`), 'Perfil creado')) refresh(); } }, 'Crear perfil') : null,
        t.profile_id ? h('button', { class: 'small', onclick: async () => { const r = await run(() => api('POST', `/api/system/zernio/tenants/${t.account_id}/sync`)); if (r) { toast(`Sincronizado: ${r.accounts} cuenta(s)`); refresh(); } } }, 'Sincronizar') : null,
        t.accounts.length ? h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmAction(`¿Desconectar todas las redes de "${t.name}"? Dejará de recibir y enviar por ellas.`))) return;
          if (await run(() => api('POST', `/api/system/zernio/tenants/${t.account_id}/disconnect-all`), 'Redes desconectadas')) refresh();
        } }, 'Desconectar todo') : null),
      linkBox(t))));

  const table = h('div');
  const tableOf = (list) => list.length
    ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Negocio'), h('th', {}, 'Perfil'), h('th', {}, 'Redes'), h('th', { class: 'num' }, 'Mensajes salientes (mes)'), h('th', {}, 'Acciones'))), h('tbody', {}, list.map(row)))
    : h('p', { class: 'muted' }, 'No hay negocios.');
  const refresh = async () => fill(table, tableOf(await api('GET', '/api/system/zernio/tenants')));
  fill(table, tableOf(tenants));

  /** Salud de todas las redes y del webhook (se revisa sola cada 6 h; "Revisar ahora" no espera). */
  const healthBox = h('div');
  const healthOf = (x) => {
    const c = x.counts || {};
    const hook = x.webhook;
    return [
      h('p', {}, `✔ ${c.ok || 0} bien · ⚠ ${c.warning || 0} con aviso · ✕ ${c.error || 0} con problema`),
      hook ? h('p', { class: `small ${hook.active ? '' : 'stats-warn'}` },
        hook.active ? '✔ Webhook activo' : '✕ Webhook apagado por Zernio',
        hook.repaired ? ' · se reactivó en la última revisión' : '',
        hook.failure_count ? ` · ${hook.failure_count} entregas fallidas seguidas` : '',
        hook.last_fired_at ? ` · último evento ${fmtDate(hook.last_fired_at)}` : '',
        hook.checked_at ? ` · revisado ${fmtDate(hook.checked_at)}` : '') : h('p', { class: 'small muted' }, 'El webhook todavía no se ha revisado.'),
      x.analytics_available === false ? h('p', { class: 'small stats-warn' }, '⚠ Tu cuenta de Zernio no tiene el complemento de estadísticas: los negocios no ven cifras nuevas de sus redes. Se vuelve a intentar cada día.') : null,
      x.broken.length ? h('div', { class: 'table-scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Negocio'), h('th', {}, 'Red'), h('th', {}, 'Desde'))),
        h('tbody', {}, x.broken.map((b) => h('tr', {}, h('td', {}, b.business), h('td', {}, ICONS[b.platform] || '🔗', ' ', label(b.platform), b.username ? ` · @${b.username}` : ''), h('td', { class: 'small' }, b.since ? fmtDate(b.since) : '—'))))))
        : h('p', { class: 'small muted' }, 'Ninguna red necesita reconectarse.'),
    ];
  };
  if (health) fill(healthBox, healthOf(health));
  const orphans = h('div');
  root.append(
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Resumen'),
      h('p', {}, `Cuentas conectadas: ${totalAccounts} · Mensajes salientes este mes: ${totalOutbound.toLocaleString('es-MX')}`),
      h('p', { class: 'small muted' }, `Costo estimado de Zernio: ~${estimate(totalAccounts, totalOutbound)} USD al mes (según su tabla pública: 2 cuentas gratis, luego por cuenta; 10 000 mensajes salientes gratis). Lo cobra Zernio a la llave de la plataforma.`),
      budget ? h('p', { class: 'small' }, `Llamadas a Zernio disponibles ahora: ${Math.floor(budget.tokens)} de ${budget.capacity} por minuto (compartidas entre todos los negocios).`) : null),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Salud de las redes'),
      h('p', { class: 'small muted' }, 'Se revisa sola cada 6 horas: a cada negocio se le avisa cuando una red se cae o su permiso está por vencer, y si Zernio apaga el webhook se reactiva y te avisamos.'),
      healthBox,
      h('button', { class: 'small', onclick: async () => {
        const r = await run(() => api('POST', '/api/system/zernio/health/check'));
        if (!r) return;
        fill(healthBox, healthOf(r.summary));
        toast(`Revisado: ${r.down} caída(s) nueva(s), ${r.back} recuperada(s), ${r.warned} aviso(s) de permiso`);
      } }, 'Revisar ahora')),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Negocios'),
      h('p', { class: 'small muted' }, 'Cada negocio tiene su propio perfil de Zernio (se crea al conectar su primera red). Puedes conectar redes por un cliente con un enlace, o directo en el panel de Zernio dentro de su perfil: se adoptan solas.'),
      table),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Webhook de Zernio'),
      h('p', { class: 'small' }, status.webhook_url ? ['Dirección: ', h('code', {}, status.webhook_url)] : ''),
      h('button', { class: 'small', onclick: loadLogs }, 'Ver entregas de los últimos 30 días'), logs),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Perfiles sin dueño'),
      h('p', { class: 'small muted' }, 'Perfiles de tu cuenta de Zernio que no son de ningún negocio de la plataforma (por ejemplo, de negocios borrados o creados a mano).'),
      h('button', { class: 'small', onclick: async () => {
        const r = await run(() => api('GET', '/api/system/zernio/orphans'));
        if (!r) return;
        fill(orphans, r.profiles.length ? h('ul', { class: 'small' }, r.profiles.map((p) => h('li', {}, `${p.name || 'Sin nombre'} · externalId: ${p.external_id || '—'} · ${p.accounts ?? '?'} cuenta(s)`))) : h('p', { class: 'small muted' }, 'No hay perfiles sin dueño.'));
      } }, 'Buscar'), orphans),
  );
}
