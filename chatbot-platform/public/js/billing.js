import { api, check, field, fill, h, num, run, state, text, toast } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';

/* ------------------------------ Mi plan y pagos ------------------------------ */

const SUB_LABEL = { incomplete: ['', 'Pago pendiente'], active: ['green', 'Al corriente'], past_due: ['orange', 'Pago pendiente'], canceled: ['red', 'Cancelado'] };

const planPrice = (p) => `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(p.price)} ${p.currency}`;

const longDate = (d) => (d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export async function viewPlan(root, params) {
  const b = await api('GET', withAcct('/api/billing'));
  const sub = b.subscription;
  const paid = params.get('pago') === 'ok';
  const live = sub && ['active', 'past_due'].includes(sub.status);
  const acc = b.account;
  const days = acc.trial_ends_at ? Math.max(0, Math.ceil((new Date(acc.trial_ends_at) - Date.now()) / 86400000)) : null;

  const status = h('div', { class: 'card' });
  if (live) {
    const plan = b.plans.find((p) => p.key === sub.plan_key);
    fill(status,
      h('div', { class: 'row between' },
        h('h3', { style: 'margin:0' }, plan ? `Plan ${plan.name}` : 'Tu plan', ' ', h('span', { class: `badge ${SUB_LABEL[sub.status][0]}` }, SUB_LABEL[sub.status][1])),
        plan ? h('strong', {}, `${planPrice(plan)} / mes`) : null),
      sub.status === 'past_due'
        ? h('p', { class: 'banner warn' }, `No pudimos cobrar tu plan. Actualiza tu forma de pago${sub.provider === 'stripe' ? ' en "Administrar pago"' : ' en Mercado Pago'} en los próximos ${b.grace_days} días para que tu asistente siga respondiendo.`)
        : h('p', { class: 'muted' }, sub.cancel_at_period_end
          ? `Tu plan se cancelará el ${longDate(sub.current_period_end)}; hasta entonces todo sigue funcionando.`
          : `Próximo cobro: ${longDate(sub.current_period_end)}.`),
      h('div', { class: 'row' },
        sub.can_portal ? h('button', { class: 'primary', onclick: async () => { const r = await run(() => api('POST', withAcct('/api/billing/portal'))); if (r) location.href = r.url; } }, 'Administrar pago y facturas') : null,
        sub.cancel_at_period_end && sub.provider === 'stripe'
          ? h('button', { onclick: async () => { if (await run(() => api('POST', withAcct('/api/billing/cancel'), { resume: true }), 'Listo: tu plan sigue activo')) render(); } }, 'Mantener mi plan')
          : !sub.cancel_at_period_end ? h('button', { class: 'danger', onclick: async () => {
            if (!confirm('¿Cancelar tu plan? Seguirás usándolo hasta el final del periodo ya pagado.')) return;
            if (await run(() => api('POST', withAcct('/api/billing/cancel'), {}), 'Cancelación registrada')) render();
          } }, 'Cancelar plan') : null));
  } else {
    fill(status,
      h('h3', { style: 'margin-top:0' }, acc.status === 'paused' ? 'Tu asistente está en pausa' : acc.status === 'trial' ? 'Estás en periodo de prueba' : 'Elige tu plan'),
      acc.status === 'trial' && days !== null ? h('p', { class: 'muted' }, days === 0 ? 'Tu prueba termina hoy.' : `Te quedan ${days} ${days === 1 ? 'día' : 'días'} de prueba. Si contratas ahora, no pierdes nada: tu cuenta sigue exactamente igual.`) : null,
      acc.status === 'paused' ? h('p', { class: 'muted' }, 'Tu configuración y tus conversaciones se conservan. Elige un plan y tu asistente vuelve a responder en cuanto se confirme el pago.') : null,
      sub?.status === 'canceled' ? h('p', { class: 'muted' }, 'Tu plan anterior se canceló. Puedes contratar de nuevo cuando quieras.') : null);
  }

  const offer = h('div');
  if (!live || sub.cancel_at_period_end) {
    if (!b.plans.length) {
      fill(offer, h('div', { class: 'card' }, h('p', {}, 'El pago en línea todavía no está disponible.'), b.support_contact ? h('p', {}, 'Para contratar escríbenos a ', h('strong', {}, b.support_contact), '.') : null));
    } else {
      fill(offer, h('div', { class: 'grid' }, b.plans.map((p) => h('div', { class: 'card' },
        h('h3', { style: 'margin:0' }, p.name),
        h('div', { class: 'kpi', style: 'margin:8px 0' }, planPrice(p), h('span', { class: 'muted small' }, ' / mes')),
        p.description ? h('p', { class: 'muted' }, p.description) : null,
        p.providers.length
          ? h('div', { class: 'stack' }, p.providers.map((pr) => h('button', { class: 'primary', onclick: async () => {
            const r = await run(() => api('POST', withAcct('/api/billing/checkout'), { plan: p.key, provider: pr.name }));
            if (r) location.href = r.url;
          } }, `Contratar con ${pr.label}`)))
          : h('p', { class: 'muted small' }, 'No disponible por ahora.')))),
      h('p', { class: 'muted small' }, 'Pago seguro en la página de Stripe o Mercado Pago: nosotros nunca vemos los datos de tu tarjeta. El cobro se renueva cada mes y puedes cancelar cuando quieras.'));
    }
  }

  root.append(
    h('h1', {}, 'Mi plan y pagos'),
    ...(paid ? [h('div', { class: 'banner' }, '¡Gracias! Estamos confirmando tu pago; en unos segundos tu plan aparece activo.',
      h('button', { class: 'small', style: 'margin-left:8px', onclick: () => { state.me = null; render(); } }, 'Actualizar'))] : []),
    status, offer);
  if (paid && !live) state.timers.push(setTimeout(() => { state.me = null; render(); }, 5000));
}

/** Superadmin: planes, claves configuradas y avisos de los proveedores. */
export async function viewPlans(root) {
  const [plans, ov] = await Promise.all([api('GET', '/api/plans'), api('GET', '/api/billing/overview')]);
  const blank = { key: '', name: '', description: '', price: 0, currency: 'MXN', stripe_price_id: '', active: true, sort_order: 0 };
  const count = (provider, status) => ov.counts.filter((c) => c.provider === provider && c.status === status).reduce((a, c) => a + c.n, 0);

  const editor = (p, isNew) => {
    const m = { ...p };
    return h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field(isNew ? 'Clave (minúsculas, sin espacios)' : 'Clave', isNew ? text(m, 'key', { placeholder: 'basico' }) : h('input', { value: p.key, disabled: true })),
        field('Nombre', text(m, 'name', { placeholder: 'Plan Básico' }))),
      field('Qué incluye', text(m, 'description', { placeholder: '1 WhatsApp, citas y automatizaciones' })),
      h('div', { class: 'grid' },
        field('Precio mensual', num(m, 'price', { step: 0.01, min: 0 })),
        field('Moneda', text(m, 'currency', { placeholder: 'MXN' })),
        field('ID de precio de Stripe (price_…)', text(m, 'stripe_price_id', { placeholder: 'price_1Abc…' }), 'Déjalo vacío si este plan solo se cobra con Mercado Pago.')),
      check(m, 'active', 'Disponible para contratar'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          const body = { ...m, price: Number(m.price) };
          if (await run(() => (isNew ? api('POST', '/api/plans', body) : api('PUT', `/api/plans/${p.key}`, body)), 'Plan guardado')) render();
        } }, 'Guardar'),
        isNew ? null : h('button', { class: 'danger', onclick: async () => { if (confirm(`¿Borrar el plan ${p.name}?`) && await run(() => api('DELETE', `/api/plans/${p.key}`), 'Borrado')) render(); } }, 'Borrar')));
  };

  const copy = (v) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(v); toast('Copiado'); } catch { toast('Cópialo a mano', true); } } }, 'Copiar');
  root.append(
    h('h1', {}, 'Planes y cobro'),
    h('div', { class: 'grid' }, ov.providers.map((pr) => h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, pr.label, ' ', h('span', { class: `badge ${pr.enabled ? 'green' : ''}` }, pr.enabled ? 'Conectado' : 'Sin configurar')),
      pr.enabled
        ? h('p', { class: 'small muted' }, `${count(pr.name, 'active')} al corriente · ${count(pr.name, 'past_due')} con pago pendiente · ${count(pr.name, 'canceled')} canceladas`)
        : h('p', { class: 'small muted' }, pr.name === 'stripe' ? 'Agrega STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET en .env y reinicia (./riverrun restart).' : 'Agrega MERCADOPAGO_ACCESS_TOKEN y MERCADOPAGO_WEBHOOK_SECRET en .env y reinicia (./riverrun restart).'),
      h('div', { class: 'small' }, 'Dirección de avisos (webhook):'),
      h('div', { class: 'row' }, h('code', { style: 'word-break:break-all' }, pr.webhook_url), copy(pr.webhook_url)),
      h('p', { class: 'small muted' }, pr.name === 'stripe' ? 'En Stripe → Desarrolladores → Webhooks: eventos checkout.session.completed, customer.subscription.*, invoice.paid e invoice.payment_failed.' : 'En Mercado Pago → Tus integraciones → Webhooks: eventos "Planes y suscripciones" (preapproval y pagos autorizados).')))),
    ...(ov.monthly_revenue.length ? [h('p', {}, h('strong', {}, 'Ingreso mensual recurrente: '), ov.monthly_revenue.map((m) => `${m.amount.toLocaleString('es-MX')} ${m.currency}`).join(' · '))] : []),
    h('h2', {}, 'Planes'),
    h('p', { class: 'muted' }, `Si un cobro falla, la cuenta sigue funcionando ${ov.grace_days} días y luego se pausa sola; al pagar, se reactiva sola.`),
    ...plans.map((p) => editor(p, false)),
    h('h3', {}, 'Agregar plan'),
    editor(blank, true));
}
