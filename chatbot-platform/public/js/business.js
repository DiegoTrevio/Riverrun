import { api, fmtDate, h } from './core.js';

/* ------------------------------ Tu negocio (superadmin) ------------------------------ */

const money = (n, currency) => `$${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 })} ${currency}`;

function tile(value, label, sub, warn = false) {
  return h('div', { class: 'card' },
    h('div', { class: 'kpi', style: warn ? 'color: var(--danger)' : '' }, value),
    h('div', { class: 'muted small' }, label),
    sub ? h('div', { class: 'small' }, sub) : null);
}

export async function viewBusiness(root) {
  const { metrics: m, golive, env } = await api('GET', '/api/platform/business');
  const conv = m.conversion.percent === null ? '—' : `${m.conversion.percent} %`;
  const mrr = m.revenue.length ? m.revenue.map((r) => money(r.mrr, r.currency)).join(' · ') : '$0';
  const arr = m.revenue.length ? m.revenue.map((r) => money(r.arr, r.currency)).join(' · ') : '$0';
  const collected = m.collected_30d.length ? m.collected_30d.map((r) => money(r.amount, r.currency)).join(' · ') : '$0';
  const attention = [
    m.disputes.open ? [`${m.disputes.open} contracargo(s) abierto(s)`, 'Respóndelos desde el proveedor de pago; el enlace te llegó por correo.'] : null,
    m.cfdi.failed ? [`${m.cfdi.failed} factura(s) que no se pudieron emitir`, 'Revisa tu cuenta de Facturapi o los datos fiscales del cliente.'] : null,
    m.actions.failed ? [`${m.actions.failed} cancelación(es) o reembolso(s) para hacer a mano`, 'Se reintentaron varias veces sin éxito; hazlos desde el proveedor.'] : null,
  ].filter(Boolean);
  const critical = golive.filter((g) => g.level === 'critical');

  root.append(
    h('h1', {}, 'Tu negocio'),
    h('p', { class: 'help' }, 'Cifras de toda la plataforma. El ingreso recurrente no incluye IVA y los planes anuales cuentan su doceava parte.'),
    attention.length
      ? h('section', { class: 'card', 'aria-labelledby': 'biz-attention' }, h('h2', { id: 'biz-attention', style: 'margin-top:0' }, 'Pide tu atención'),
        h('ul', {}, attention.map(([t, d]) => h('li', {}, h('strong', {}, t), ' — ', d))))
      : h('p', { class: 'banner ok', role: 'status' }, 'Nada pide tu atención: los cobros, facturas y reintentos se están resolviendo solos.'),
    h('h2', {}, 'Ingresos'),
    h('div', { class: 'grid' },
      tile(mrr, 'Ingreso mensual recurrente (MRR)'),
      tile(arr, 'Ingreso anual recurrente (ARR)'),
      tile(collected, 'Cobrado en 30 días', 'sin IVA y descontando reembolsos')),
    h('h2', {}, 'Clientes'),
    h('div', { class: 'grid' },
      tile(String(m.signups.last_30d), 'Registros en 30 días', `los 30 anteriores: ${m.signups.prev_30d}`),
      tile(String(m.trials_active), 'Pruebas activas'),
      tile(conv, 'Conversión de prueba a pago', `${m.conversion.paid} de ${m.conversion.ended} pruebas terminadas en 90 días`),
      tile(String(m.subscriptions.active), 'Suscripciones activas'),
      tile(String(m.subscriptions.canceled_30d), 'Bajas en 30 días')),
    h('h2', {}, 'Cobro y facturas'),
    h('div', { class: 'grid' },
      tile(String(m.subscriptions.past_due), 'Cobros fallidos en curso', 'se recuerdan solos y se pausan al terminar la gracia'),
      tile(String(m.disputes.open), 'Contracargos abiertos', m.disputes.lost_30d ? `${m.disputes.lost_30d} perdidos en 30 días` : null, m.disputes.open > 0),
      tile(String(m.cfdi.pending), 'Facturas (CFDI) por emitir', m.cfdi.failed ? `${m.cfdi.failed} con error` : null, m.cfdi.failed > 0),
      tile(m.last_reconciled_at ? fmtDate(m.last_reconciled_at) : 'Todavía no', 'Última revisión contra el proveedor', 'una vez al día por suscripción')),
    h('section', { class: 'card', 'aria-labelledby': 'biz-golive' },
      h('h2', { id: 'biz-golive', style: 'margin-top:0' }, 'Para cobrar de verdad'),
      golive.length
        ? [h('p', { class: critical.length ? 'banner danger' : 'muted' }, critical.length
          ? `${critical.length} punto(s) crítico(s): ${env === 'production' ? 'el servidor no arranca en modo estricto hasta corregirlos' : 'corrígelos antes de pasar a producción'}.`
          : 'Revisa estos puntos antes de abrir el cobro al público:'),
        h('ul', {}, golive.map((g) => h('li', {}, h('strong', {}, g.level === 'critical' ? 'Crítico: ' : 'Aviso: '), g.message, h('br'), h('span', { class: 'muted small' }, g.fix))))]
        : h('p', {}, 'La configuración de cobro, facturas y avisos está completa.'),
      h('p', { class: 'small muted' }, 'La guía completa está en docs/produccion.md («Pasar a cobro real»).')),
    h('p', { class: 'small muted' }, m.digest_pending
      ? `${m.digest_pending} aviso(s) esperan el resumen diario por correo. Lo urgente te llega al momento.`
      : 'Los avisos que no son urgentes te llegan juntos en un correo al día; lo urgente, al momento.'),
  );
}
