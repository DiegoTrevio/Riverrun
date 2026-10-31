import { api, check, clearFieldErrors, field, fill, h, num, run, select, showFieldErrors, state, text, toast, confirmAction } from './core.js';
import { okMark } from './icons.js';
import { render } from './main.js';
import { isOwner, ownerOnlyText, withAcct } from './session.js';
import { needsOnboarding } from './shell.js';

/* ------------------------------ Mi plan y pagos ------------------------------ */

const SUB_LABEL = { incomplete: ['', 'Pago pendiente'], active: ['green', 'Al corriente'], past_due: ['orange', 'Pago pendiente'], canceled: ['red', 'Cancelado'] };

const amount = (n) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
/** Precio publicado: sin IVA, "+ IVA". */
export const planPrice = (p) => `$${amount(p.price)} ${p.currency}${p.tax_percent ? ' + IVA' : ''}`;
/** Periodo de cobro del plan. */
export const per = (p) => (p.interval === 'year' ? 'año' : 'mes');
/** Lo que se cobra en total, con IVA ("" si no se suma IVA). */
export const totalText = (p) => (p.tax_percent ? `Total con IVA (${p.tax_percent} %): $${amount(p.total)} ${p.currency} al ${per(p)}` : '');

/** El proveedor por su nombre («Agregar tarjeta con Stripe»): su etiqueta ya dice «Tarjeta (Stripe)». */
const PROVIDER_NAME = { stripe: 'Stripe', mercadopago: 'Mercado Pago' };

const PAY_LABEL = { paid: ['green', 'Pagado'], partially_refunded: ['orange', 'Reembolso parcial'], refunded: ['', 'Reembolsado'] };
const money = (n, currency) => `$${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${currency}`;

/** Enlaces de descarga del PDF y el XML de un CFDI. */
const cfdiLinks = (id, what) => [
  h('a', { href: withAcct(`/api/billing/invoices/${id}/pdf`), download: '', 'aria-label': `${what}: PDF` }, 'PDF'), ' · ',
  h('a', { href: withAcct(`/api/billing/invoices/${id}/xml`), download: '', 'aria-label': `${what}: XML` }, 'XML'),
];

/** Columna «Factura» de un pago: su CFDI, la global del mes en la que entró, o en qué va. */
function cfdiCell(c, p) {
  if (!c) return '—';
  const credits = c.credits.map((n) => h('div', { class: 'muted small' }, `Nota de crédito ${money(n.amount, p.currency)}: `,
    n.status === 'issued' ? cfdiLinks(n.id, 'Nota de crédito') : 'en trámite'));
  if (c.status === 'issued') return [cfdiLinks(c.id, `Factura del ${longDate(p.paid_at)}`), ...credits];
  if (c.status === 'global') return h('span', { class: 'muted small' }, 'En la factura global del mes (público en general)');
  if (c.status === 'pending') return h('span', { class: 'muted small' }, 'En trámite');
  if (c.status === 'failed' && c.error) return h('div', {}, h('button', { class: 'small', onclick: () => document.getElementById('fiscal-title')?.scrollIntoView({ block: 'start' }) }, 'Revisa tus datos fiscales'), h('div', { class: 'error small' }, c.error));
  if (c.status === 'failed') return h('span', { class: 'muted small' }, 'Con retraso: la estamos revisando');
  return '—';
}

const longDate = (d) => (d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

const LIMIT_SHORT = { messages_per_month: ['mensajes al mes', 'mensaje al mes'], channels: ['canales', 'canal'], users: ['usuarios', 'usuario'], chatbots: ['asistentes', 'asistente'], social_accounts: ['redes sociales', 'red social'] };
/** "hasta 1,000 mensajes al mes · 1 canal · …" (vacío si el plan no tiene límites). */
export const limitsText = (limits = {}) => Object.entries(LIMIT_SHORT).filter(([k]) => limits[k]).map(([k, [pl, sg]]) => `${limits[k].toLocaleString('es-MX')} ${limits[k] === 1 ? sg : pl}`).join(' · ');

/** Persona del RFC: 12 caracteres = empresa (moral), 13 = persona física. */
const personaOf = (rfc) => (rfc.length === 12 ? 'moral' : rfc.length === 13 ? 'fisica' : '');

/**
 * Tarjeta «Facturación»: con o sin factura y, con factura, los datos de la Constancia de Situación Fiscal. Los errores
 * del servidor se muestran junto a cada campo.
 */
async function fiscalCard(onSaved) {
  const r = await api('GET', withAcct('/api/billing/fiscal'));
  const f = { ...r.fiscal };
  const card = h('section', { class: 'card', 'aria-labelledby': 'fiscal-title' });
  const regime = h('select', { name: 'tax_regime' });
  const use = h('select', { name: 'cfdi_use' });
  const fillRegimes = () => {
    const p = personaOf(f.rfc.trim());
    const list = r.regimes.filter((x) => !p || x.for.includes(p));
    if (!list.some((x) => x.code === f.tax_regime)) f.tax_regime = '';
    regime.replaceChildren(h('option', { value: '' }, p ? 'Elige tu régimen' : 'Primero escribe tu RFC'), ...list.map((x) => h('option', { value: x.code, selected: x.code === f.tax_regime }, x.label)));
    fillUses();
  };
  // Al cambiar de régimen se propone su primer uso (Gastos en general, si aplica).
  const fillUses = (reset = false) => {
    const allowed = r.uses_by_regime[f.tax_regime] || ['S01'];
    if (reset || !allowed.includes(f.cfdi_use)) f.cfdi_use = allowed[0];
    use.replaceChildren(...r.uses.filter((u) => allowed.includes(u.code)).map((u) => h('option', { value: u.code, selected: u.code === f.cfdi_use }, u.label)));
  };
  regime.onchange = (e) => { f.tax_regime = e.target.value; fillUses(true); };
  use.onchange = (e) => { f.cfdi_use = e.target.value; };
  const rfc = text(f, 'rfc', { maxlength: 13, autocomplete: 'off', placeholder: 'XAXX010101000', style: 'text-transform:uppercase', oninput: () => fillRegimes() });
  const details = h('div', { hidden: !f.wants_invoice },
    h('div', { class: 'grid' },
      field('RFC', rfc),
      field('Nombre o razón social', text(f, 'legal_name', { maxlength: 300 }), 'Tal como aparece en tu Constancia de Situación Fiscal, sin «S.A. de C.V.».'),
      field('Régimen fiscal', regime),
      field('Código postal fiscal', text(f, 'zip', { maxlength: 5, inputmode: 'numeric', autocomplete: 'postal-code' })),
      field('Uso del CFDI', use),
      field('Correo para tus facturas (opcional)', text(f, 'invoice_email', { type: 'email', autocomplete: 'email' }), 'Si lo dejas vacío, las enviamos al correo del dueño de la cuenta.')));
  const choice = (value, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'wants_invoice', value, checked: f.wants_invoice === (value === 'yes'), onchange: () => { f.wants_invoice = value === 'yes'; details.hidden = !f.wants_invoice; } }), label);
  fillRegimes();
  fill(card,
    h('h2', { id: 'fiscal-title', style: 'margin-top:0' }, 'Facturación'),
    h('fieldset', { class: 'field' }, h('legend', {}, '¿Quieres factura?'),
      choice('no', 'Sin factura (tus pagos se incluyen en la factura a público en general)'),
      choice('yes', 'Con factura a mi nombre')),
    details,
    h('p', { class: 'muted small' }, 'Con factura, cada pago genera tu CFDI y te llega por correo; si el SAT rechaza tus datos, te avisamos. Los cambios aplican a los pagos de este mes en adelante.'),
    h('button', { class: 'primary', onclick: async () => {
      clearFieldErrors(card);
      try {
        await api('PUT', withAcct('/api/billing/fiscal'), { ...f, rfc: f.rfc.trim().toUpperCase() });
        toast(f.wants_invoice ? 'Datos de facturación guardados' : 'Listo: sin factura');
        onSaved();
      } catch (e) {
        // Cada error junto a su campo (el mismo helper que usa todo el panel); lo que no tiene campo va al aviso.
        const loose = showFieldErrors(card, e.issues || []);
        if (!e.issues?.length) toast(e.message || 'No se pudo guardar', true);
        else if (loose.length) toast(loose.join('; '), true);
      }
    } }, 'Guardar'));
  return card;
}

/** Abre la página del proveedor que devuelve la ruta (cambiar tarjeta). */
async function goPay(path) {
  const r = await run(() => api('POST', withAcct(path)));
  if (r?.url) location.href = r.url;
}

/** Costo al mes (los anuales, su doceava parte): para saber si un cambio sube o baja. */
const monthly = (p) => (p.interval === 'year' ? p.price / 12 : p.price);

/** Qué pasa con el cobro al cambiar de plan, en palabras del cliente. */
function changeEffect(sub, from, to) {
  if (sub.provider === 'mercadopago') {
    if (from && from.interval !== to.interval) return 'Te llevamos a Mercado Pago para autorizar el nuevo cobro; empieza cuando termine lo que ya pagaste.';
    const price = totalText(to) ? `$${amount(to.total)} ${to.currency} con IVA` : planPrice(to);
    // Mercado Pago no cobra la diferencia: al subir, el plan nuevo empieza con el cobro de su precio.
    return !from || monthly(to) > monthly(from)
      ? `Tu plan cambia a ${to.name} con tu siguiente cobro, el ${longDate(sub.current_period_end)} (${price}). Hasta entonces sigues con tu plan actual.`
      : `El nuevo precio (${price}) se cobra desde tu siguiente pago, el ${longDate(sub.current_period_end)}.`;
  }
  return !from || monthly(to) > monthly(from)
    ? 'Hoy se cobra la parte proporcional de lo que queda de tu periodo.'
    : 'Lo que ya pagaste del plan actual se descuenta de tu siguiente cobro.';
}

/** Consultas al proveedor tras volver del pago (cada 4 s, hasta 1 minuto); luego lo confirma la revisión periódica. */
let confirmTries = 0;
const MAX_CONFIRM_TRIES = 15;

export async function viewPlan(root, params) {
  const paid = params.get('pago') === 'ok';
  if (!paid) confirmTries = 0;
  // Solo el dueño maneja el plan y los pagos: los demás administradores lo ven sin botones.
  const mine = isOwner();
  if (paid && confirmTries < MAX_CONFIRM_TRIES && mine) {
    confirmTries++;
    // Se pregunta al proveedor por el pago: la cuenta se activa sin esperar su aviso.
    const c = await api('POST', withAcct('/api/billing/confirm')).catch(() => null);
    // Recién activada: se vuelve a dibujar todo (menú y avisos incluidos) con la cuenta al día.
    if (c?.confirmed) { state.me = null; render(); return; }
  }
  const b = await api('GET', withAcct('/api/billing'));
  const sub = b.subscription;
  const live = sub && ['active', 'past_due'].includes(sub.status);
  const acc = b.account;
  const cc = b.card_check;
  const days = acc.trial_ends_at ? Math.max(0, Math.ceil((new Date(acc.trial_ends_at) - Date.now()) / 86400000)) : null;

  const status = h('div', { class: 'card' });
  if (live) {
    const plan = b.plans.find((p) => p.key === sub.plan_key);
    const next = sub.pending_plan_key ? b.plans.find((p) => p.key === sub.pending_plan_key) : null;
    fill(status,
      h('div', { class: 'row between' },
        h('h2', { style: 'margin:0' }, plan ? `Plan ${plan.name}` : 'Tu plan', ' ', h('span', { class: `badge ${SUB_LABEL[sub.status][0]}` }, SUB_LABEL[sub.status][1])),
        plan ? h('strong', {}, `${planPrice(plan)} / ${per(plan)}`) : null),
      sub.status === 'past_due'
        ? h('p', { class: 'banner warn' }, `No pudimos cobrar tu plan. Actualiza tu forma de pago${sub.provider === 'stripe' ? ' en "Administrar pago"' : ' con «Cambiar tarjeta»'} en los próximos ${b.grace_days} días para que tu asistente siga respondiendo.`)
        : h('p', { class: 'muted' }, sub.cancel_at_period_end
          ? `Tu plan se cancelará el ${longDate(sub.current_period_end)}; hasta entonces todo sigue funcionando.`
          : `Próximo cobro: ${longDate(sub.current_period_end)}.${next ? ` Con ese cobro cambias al plan ${next.name}.` : ''}`),
      mine && next && plan && !sub.cancel_at_period_end ? h('div', { class: 'row' }, h('button', { onclick: async () => {
        if (await run(() => api('POST', withAcct('/api/billing/change'), { plan: plan.key }), `Listo: sigues con el plan ${plan.name}`)) render();
      } }, `Quedarme con el plan ${plan.name}`)) : null,
      !mine ? null : h('div', { class: 'row' },
        sub.can_portal ? h('button', { class: 'primary', onclick: async () => { const r = await run(() => api('POST', withAcct('/api/billing/portal'))); if (r) location.href = r.url; } }, 'Administrar pago y facturas') : null,
        sub.provider === 'mercadopago' && !sub.cancel_at_period_end ? h('button', { onclick: () => goPay('/api/billing/payment-method') }, 'Cambiar tarjeta') : null,
        sub.cancel_at_period_end
          ? h('button', { onclick: async () => {
            // Mercado Pago no reanuda: se autoriza de nuevo el mismo plan, con el primer cobro al terminar lo ya pagado.
            const r = await run(() => api('POST', withAcct('/api/billing/cancel'), { resume: true }), sub.provider === 'stripe' ? 'Listo: tu plan sigue activo' : undefined);
            if (r?.url) location.href = r.url; else if (r) render();
          } }, 'Mantener mi plan')
          : !sub.cancel_at_period_end ? h('button', { class: 'danger', onclick: async () => {
            if (!await confirmAction('¿Cancelar tu plan? Seguirás usándolo hasta el final del periodo ya pagado.')) return;
            if (await run(() => api('POST', withAcct('/api/billing/cancel'), {}), 'Cancelación registrada')) render();
          } }, 'Cancelar plan') : null));
  } else if (cc?.waiting) {
    // Cuenta nueva que espera su tarjeta: en qué paso va, el plan que eligió y por qué no avanza.
    const chosen = b.plans.find((p) => p.key === cc.signup_plan);
    const until = longDate(new Date(Date.now() + cc.trial_days * 86400000));
    const step = (done, text, extra = null) => h('li', { class: done ? 'ok' : '' }, okMark(done), ' ', text, extra);
    fill(status,
      h('h2', { style: 'margin-top:0' }, cc.trial_available ? `Activa tu prueba gratis de ${cc.trial_days} días` : 'Elige tu plan'),
      h('ul', { class: 'checklist', 'aria-label': 'Pasos para activar tu cuenta' },
        step(true, 'Creaste tu cuenta'),
        step(cc.email_verified, cc.email_verified ? 'Verificaste tu correo' : 'Falta verificar tu correo',
          !cc.email_verified && mine ? [' ', h('button', { class: 'small', onclick: () => run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace') }, 'Reenviar')] : null),
        step(false, cc.trial_available ? `Agrega tu tarjeta: no se cobra nada hasta el ${until}` : 'Contrata tu plan')),
      chosen ? h('p', {}, `Al registrarte elegiste el plan ${chosen.name}.`) : null,
      cc.card_used ? h('p', { class: 'banner warn' }, h('strong', {}, 'Esta tarjeta ya tuvo una prueba gratis. '),
        cc.trial_available ? 'Usa otra tarjeta para tu prueba, o contrata ya con el primer cobro hoy.' : 'Contrata tu plan para activar tu asistente.') : null,
      !cc.trial_available && !cc.card_used ? h('p', { class: 'banner warn' }, 'Ya usaste tu prueba gratis con este correo') : null,
      cc.brake ? h('p', { class: 'banner warn', role: 'status' }, 'Por ahora no podemos abrir la verificación de tarjeta. Intenta más tarde.') : null,
      h('p', { class: 'muted small' }, 'Mientras tanto puedes configurar tu asistente: empieza a responder y a usar la IA en cuanto empiece tu prueba.'));
  } else {
    fill(status,
      h('h2', { style: 'margin-top:0' }, acc.status === 'paused' ? 'Tu asistente está en pausa' : acc.status === 'trial' ? 'Estás en periodo de prueba' : 'Elige tu plan'),
      acc.status === 'trial' && days !== null ? h('p', { class: 'muted' }, days === 0 ? 'Tu prueba termina hoy.' : `Te quedan ${days} ${days === 1 ? 'día' : 'días'} de prueba. Si contratas ahora, no pierdes nada: tu cuenta sigue exactamente igual.`) : null,
      acc.status === 'paused' ? h('p', { class: 'muted' }, 'Tu configuración y tus conversaciones se conservan. Elige un plan y tu asistente vuelve en cuanto se confirme el pago.') : null,
      sub?.status === 'canceled' ? h('p', { class: 'muted' }, 'Tu plan anterior se canceló. Puedes contratar de nuevo cuando quieras.') : null);
  }

  // Desde un límite o un aviso de uso: el plan sugerido queda elegido (un clic para subir).
  const wanted = params.get('subir') || params.get('plan') || cc?.signup_plan;
  // Con un cobro fallido en Mercado Pago, primero «Cambiar tarjeta» (cobra lo pendiente); después se cambia de plan.
  const mpDue = sub?.provider === 'mercadopago' && sub.status === 'past_due';
  const others = mine && live && !sub.cancel_at_period_end && !mpDue ? b.plans.filter((p) => p.key !== sub.plan_key) : [];
  const current = live ? b.plans.find((p) => p.key === sub.plan_key) : null;
  const change = others.length
    ? h('section', { class: 'card', 'aria-labelledby': 'change-plan' },
      h('h2', { id: 'change-plan', style: 'margin-top:0' }, 'Cambiar de plan'),
      h('div', { class: 'grid' }, others.map((p) => h('div', { class: p.key === wanted ? 'card chosen' : 'card' },
        h('h3', { style: 'margin:0' }, p.name),
        h('div', { class: 'kpi', style: 'margin:8px 0' }, planPrice(p), h('span', { class: 'muted small' }, ` / ${per(p)}`)),
        totalText(p) ? h('p', { class: 'muted small', style: 'margin-top:0' }, totalText(p)) : null,
        limitsText(p.limits) ? h('p', { class: 'small' }, okMark(true), ' Incluye ', limitsText(p.limits)) : h('p', { class: 'small' }, okMark(true), ' Sin límites de uso'),
        p.key === sub.pending_plan_key ? h('button', { disabled: true }, 'Empieza con tu siguiente cobro') : h('button', { class: 'primary', onclick: async () => {
          if (!await confirmAction(`¿Cambiar al plan ${p.name}? ${changeEffect(sub, current, p)}`)) return;
          const r = await run(() => api('POST', withAcct('/api/billing/change'), { plan: p.key }));
          if (r?.url) location.href = r.url;
          // Sin el plan sugerido en la dirección (cambiar la dirección ya vuelve a dibujar la página).
          else if (r) {
            toast(r.scheduled ? `Listo: el plan ${p.name} empieza ${r.starts_at ? `el ${longDate(r.starts_at)}` : 'con tu siguiente cobro'}` : `Listo: ahora tienes el plan ${p.name}`);
            if (location.hash !== '#/plan') location.hash = '#/plan'; else render();
          }
          // En Mercado Pago, subir empieza con el siguiente cobro: «ahora» sería una promesa falsa.
        } }, p.key === wanted ? (sub.provider === 'mercadopago' ? `Subir a ${p.name}` : `Subir ahora a ${p.name}`) : `Cambiar a ${p.name}`)))))
    : null;

  const waiting = paid && !live;
  const gaveUp = waiting && confirmTries >= MAX_CONFIRM_TRIES;
  const offer = h('div');
  // Esperando tarjeta con prueba disponible: el pago es la verificación de la tarjeta (sin cobro hasta que termine).
  const trialOffer = !!cc?.waiting && cc.trial_available;
  const unverified = !!cc?.waiting && !cc.email_verified;
  const payButton = (p, pr, label, cls, trial) => h('button', { class: cls, disabled: unverified, title: unverified ? 'Falta verificar tu correo' : '', onclick: async () => {
    const r = await run(() => api('POST', withAcct('/api/billing/checkout'), { plan: p.key, provider: pr.name, ...(trial === false ? { trial: false } : {}) }));
    if (r) location.href = r.url;
  } }, label);
  // Mientras se confirma un pago no se ofrece contratar otra vez: un segundo clic abriría otra suscripción.
  if (mine && (!live || sub.cancel_at_period_end) && !(waiting && !gaveUp)) {
    if (!b.plans.length) {
      fill(offer, h('div', { class: 'card' }, h('p', {}, 'El pago en línea todavía no está disponible.'), b.support_contact ? h('p', {}, 'Para contratar escríbenos a ', h('strong', {}, b.support_contact), '.') : null));
    } else {
      fill(offer, h('div', { class: 'grid' }, b.plans.map((p) => h('div', { class: p.key === wanted ? 'card chosen' : 'card' },
        h('h2', { style: 'margin:0' }, p.name),
        h('div', { class: 'kpi', style: 'margin:8px 0' }, planPrice(p), h('span', { class: 'muted small' }, ` / ${per(p)}`)),
        totalText(p) ? h('p', { class: 'muted small', style: 'margin-top:0' }, totalText(p)) : null,
        p.description ? h('p', { class: 'muted' }, p.description) : null,
        limitsText(p.limits) ? h('p', { class: 'small' }, okMark(true), ' Incluye ', limitsText(p.limits)) : h('p', { class: 'small' }, okMark(true), ' Sin límites de uso'),
        p.providers.length
          ? h('div', { class: 'stack' }, p.providers.flatMap((pr) => [
            payButton(p, pr, trialOffer ? `${cc.card_used ? 'Usar otra tarjeta' : 'Agregar tarjeta'} con ${PROVIDER_NAME[pr.name] || pr.label}` : `Contratar con ${pr.label}`, 'primary'),
            // La tarjeta ya tuvo prueba: también se puede contratar ya, sin días gratis.
            trialOffer && cc.card_used ? payButton(p, pr, `Contratar con ${pr.label}`, '', false) : null]))
          : h('p', { class: 'muted small' }, 'No disponible por ahora.')))),
      h('p', { class: 'muted small' }, 'Pago seguro en la página de Stripe o Mercado Pago: nosotros nunca vemos los datos de tu tarjeta.',
        trialOffer ? ` Con la prueba, el primer cobro es al terminar los ${cc.trial_days} días; si cancelas antes, no se cobra nada.` : '',
        b.plans.some((p) => p.tax_percent) ? ' Los precios no incluyen IVA: se cobra el total con IVA.' : '',
        ' El cobro se renueva solo y puedes cancelar cuando quieras.'));
    }
  }

  const usage = b.limits.items.some((i) => i.max)
    ? h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Tu uso', ' ', h('span', { class: 'muted small' }, b.limits.source === 'trial' ? '(periodo de prueba)' : b.limits.source === 'override' ? '(límites especiales)' : '')),
      b.limits.items.filter((i) => i.max).map((i) => h('div', { style: 'margin:10px 0' },
        h('div', { class: 'row between small' }, h('span', {}, i.label), h('span', { class: i.percent >= 100 ? 'error' : 'muted' }, `${i.used.toLocaleString('es-MX')} de ${i.max.toLocaleString('es-MX')}`)),
        h('div', { class: 'bar' }, h('div', { class: `bar-fill ${i.percent >= 100 ? 'full' : i.percent >= 80 ? 'warn' : ''}`, style: `width:${i.percent}%` })))),
      b.limits.items.some((i) => i.key === 'messages_per_month' && i.max) ? h('p', { class: 'muted small', style: 'margin-bottom:0' }, 'Se cuentan por mes (el día 1 vuelven a cero). Al llegar al límite el asistente deja de responder; las conversaciones se siguen guardando.') : null)
    : null;
  const notice = paid && live
    ? h('div', { class: 'banner' }, h('strong', {}, '¡Listo, tu plan está activo! '), 'Te enviamos la confirmación por correo.',
      needsOnboarding() ? [' ', h('a', { class: 'btn primary', href: '#/empezar' }, 'Termina de configurar tu agente →')] : null)
    : waiting
      ? h('div', { class: 'banner', role: 'status' }, gaveUp
        ? 'Tu pago se está procesando. En cuanto el banco lo confirme tu plan se activa solo y te avisamos por correo; mientras, puedes seguir configurando tu asistente.'
        : '¡Gracias! Estamos confirmando tu pago; en unos segundos tu plan aparece activo.',
      h('button', { class: 'small', style: 'margin-left:8px', onclick: () => { confirmTries = 0; state.me = null; render(); } }, 'Actualizar'))
      : params.get('pago') === 'cancelado'
        ? h('div', { class: 'banner warn' }, 'No se completó el pago y no se te cobró nada. Puedes intentarlo de nuevo cuando quieras.')
        : null;
  const history = b.payments?.length
    ? h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Tus pagos'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Fecha'), h('th', {}, 'Concepto'), h('th', { class: 'num' }, 'Subtotal'), h('th', { class: 'num' }, 'IVA'), h('th', { class: 'num' }, 'Total'), h('th', {}, 'Estado'), h('th', {}, 'Factura'))),
        h('tbody', {}, b.payments.map((p) => {
          const plan = b.plans.find((x) => x.key === p.plan_key);
          return h('tr', {},
            h('td', {}, longDate(p.paid_at)),
            h('td', {}, plan ? `Plan ${plan.name}` : 'Suscripción', p.period_end ? h('div', { class: 'muted small' }, `Hasta el ${longDate(p.period_end)}`) : null),
            h('td', { class: 'num' }, money(p.subtotal, p.currency)),
            h('td', { class: 'num' }, money(p.tax, p.currency)),
            h('td', { class: 'num' }, h('strong', {}, money(p.total, p.currency)), p.refunded ? h('div', { class: 'muted small' }, `Reembolsado: ${money(p.refunded, p.currency)}`) : null),
            h('td', {}, h('span', { class: `badge ${PAY_LABEL[p.status][0]}` }, PAY_LABEL[p.status][1])),
            h('td', {}, mine ? cfdiCell(p.cfdi, p) : null));
        }))),
      h('p', { class: 'muted small', style: 'margin-bottom:0' }, b.invoicing ? 'Cada pago se registra con su IVA desglosado. Tus facturas llegan por correo con su PDF y XML.' : 'Cada pago se registra con su IVA desglosado.'))
    : null;
  const fiscal = mine ? await fiscalCard(() => render()).catch(() => null) : null;
  // Pidió factura sin completar sus datos: se avisa antes de pagar (el servidor también lo exige).
  const fiscalMissing = mine && b.fiscal?.wants_invoice && !b.fiscal.complete && (!live || sub.cancel_at_period_end)
    ? h('p', { class: 'banner warn' }, 'Pediste factura: completa tus datos en «Facturación» antes de contratar.')
    : null;
  const readOnly = mine ? null : h('p', { class: 'banner', role: 'status' }, ownerOnlyText());
  root.append(h('h1', {}, 'Mi plan y pagos'), readOnly, notice, status, change, fiscal, usage, fiscalMissing, offer, history, dataCard());
  // El plan sugerido a la vista (el foco queda en el título, como en toda página nueva).
  if (params.get('subir')) root.querySelector('.card.chosen')?.scrollIntoView({ block: 'center' });
  if (waiting && !gaveUp) state.timers.push(setTimeout(() => { state.me = null; render(); }, 4000));
}

/**
 * «Tus datos»: el dueño descarga todo lo de su cuenta (ZIP) o la borra. Borrar pide escribir el nombre de la cuenta y
 * se confirma desde el correo; con el borrado ya programado, se puede cancelar.
 */
function dataCard() {
  const { user, account } = state.me || {};
  if (!account || user?.role !== 'admin') return null;
  const owner = isOwner();
  const fmtDay = (d) => new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  const confirm = { text: '' };
  const removal = account.deletion_scheduled_for
    ? [h('p', { class: 'banner danger' }, `Tu cuenta se borrará el ${fmtDay(account.deletion_scheduled_for)}.`),
      !owner ? h('p', { class: 'muted small' }, ownerOnlyText()) : h('button', { onclick: async () => {
        const r = await run(() => api('DELETE', '/api/account/deletion'), 'Listo: tu cuenta ya no se borrará');
        if (r?.resubscribe) toast('Tu plan quedó cancelado: vuelve a contratarlo en esta página para que siga activo.');
        if (r) { state.me = null; render(); }
      } }, 'Cancelar el borrado')]
    : owner
      ? [h('p', { class: 'muted small' }, 'Se borran tu agente, sus conexiones, tus contactos y tus conversaciones; tus pagos y facturas se conservan por ley. Lo confirmas por correo y tienes 7 días para cancelarlo.'),
        field(`Para confirmar, escribe el nombre de tu cuenta («${account.name}»)`, text(confirm, 'text', { autocomplete: 'off' })),
        h('button', { class: 'danger', onclick: async () => {
          const r = await run(() => api('POST', '/api/account/deletion', { confirm: confirm.text }));
          if (r) toast(`Te enviamos un correo a ${r.email} para confirmar el borrado`);
        } }, 'Borrar mi cuenta')]
      : [h('p', { class: 'muted small' }, ownerOnlyText())];
  return h('section', { class: 'card', 'aria-labelledby': 'data-title' },
    h('h2', { id: 'data-title', style: 'margin-top:0' }, 'Tus datos'),
    owner ? [h('p', {}, 'Descarga todo lo de tu cuenta: configuración, agentes y su conocimiento, contactos, conversaciones, cotizaciones, pagos y facturas.'),
      h('a', { class: 'btn', href: withAcct('/api/account/export.zip'), download: '', onclick: async (e) => {
        // La descarga es un enlace (no pasa por api()): primero confirma con el código si hace falta.
        e.preventDefault();
        const { ensureRecentMfa } = await import('./mfa.js');
        if (await ensureRecentMfa()) location.href = e.currentTarget?.href || withAcct('/api/account/export.zip');
      } }, 'Descargar todos mis datos (ZIP)')] : null,
    h('h3', {}, 'Borrar mi cuenta'),
    removal);
}

/** Superadmin: planes, claves configuradas y avisos de los proveedores. */
export async function viewPlans(root) {
  const [plans, ov] = await Promise.all([api('GET', '/api/plans'), api('GET', '/api/billing/overview')]);
  const blank = { key: '', name: '', description: '', price: 0, currency: 'MXN', interval: 'month', tax_percent: ov.tax_percent, stripe_price_id: '', active: true, sort_order: 0, limits: {}, ai_usd_per_month: null };
  const count = (provider, status) => ov.counts.filter((c) => c.provider === provider && c.status === status).reduce((a, c) => a + c.n, 0);

  const editor = (p, isNew) => {
    const m = { ...p, limits: { ...(p.limits || {}) } };
    return h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field(isNew ? 'Clave (minúsculas, sin espacios)' : 'Clave', isNew ? text(m, 'key', { placeholder: 'basico' }) : h('input', { value: p.key, disabled: true })),
        field('Nombre', text(m, 'name', { placeholder: 'Plan Básico' }))),
      field('Qué incluye', text(m, 'description', { placeholder: '1 WhatsApp, citas y automatizaciones' })),
      h('div', { class: 'grid' },
        field('Precio sin IVA', num(m, 'price', { step: 0.01, min: 0 }), p.tax_percent ? `Se publica "+ IVA" y se cobra el precio más ${p.tax_percent} % de IVA.` : undefined),
        field('Se cobra', select(m, 'interval', [['month', 'Cada mes'], ['year', 'Cada año']])),
        field('Moneda', text(m, 'currency', { placeholder: 'MXN' })),
        field('ID de precio de Stripe (opcional)', text(m, 'stripe_price_id', { placeholder: 'price_1Abc…' }), 'Déjalo vacío: Stripe cobra el precio con IVA, la moneda y el periodo de este plan automáticamente. Úsalo solo si ya tienes un precio creado en Stripe por el total con IVA y el mismo periodo.')),
      h('h3', { style: 'margin:12px 0 4px' }, 'Límites del plan', h('span', { class: 'muted small' }, ' (vacío = sin límite)')),
      h('div', { class: 'grid' },
        field('Mensajes del asistente al mes', num(m.limits, 'messages_per_month', { min: 1, nullable: true, placeholder: 'Sin límite' })),
        field('Canales', num(m.limits, 'channels', { min: 1, nullable: true, placeholder: 'Sin límite' })),
        field('Usuarios', num(m.limits, 'users', { min: 1, nullable: true, placeholder: 'Sin límite' })),
        field('Asistentes', num(m.limits, 'chatbots', { min: 1, nullable: true, placeholder: 'Sin límite' })),
        field('Redes sociales', num(m.limits, 'social_accounts', { min: 1, nullable: true, placeholder: 'Sin límite' }), 'Cuentas conectadas por Zernio (cada una tiene costo para la plataforma).'),
        field('Gasto de IA al mes (USD)', num(m, 'ai_usd_per_month', { min: 0, step: 0.01, nullable: true, placeholder: 'Sin tope' }), 'Lo que la plataforma paga de IA por cada cuenta con este plan. Al llegar, la IA se detiene hasta el mes siguiente; el cliente no lo puede cambiar.')),
      check(m, 'active', 'Disponible para contratar'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          const body = { ...m, price: Number(m.price), limits: Object.fromEntries(Object.entries(m.limits).filter(([, v]) => v)) };
          if (await run(() => (isNew ? api('POST', '/api/plans', body) : api('PUT', `/api/plans/${p.key}`, body)), 'Plan guardado')) render();
        } }, 'Guardar'),
        isNew ? null : h('button', { class: 'danger', onclick: async () => { if (await confirmAction(`¿Borrar el plan ${p.name}?`) && await run(() => api('DELETE', `/api/plans/${p.key}`), 'Borrado')) render(); } }, 'Borrar')));
  };

  const copy = (v) => h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(v); toast('Copiado'); } catch { toast('Cópialo a mano', true); } } }, 'Copiar');
  root.append(
    h('h1', {}, 'Planes y cobro'),
    h('div', { class: 'grid' }, ov.providers.map((pr) => h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, pr.label, ' ', h('span', { class: `badge ${pr.enabled ? 'green' : ''}` }, pr.enabled ? 'Conectado' : 'Sin configurar')),
      pr.enabled
        ? h('p', { class: 'small muted' }, `${count(pr.name, 'active')} al corriente · ${count(pr.name, 'past_due')} con pago pendiente · ${count(pr.name, 'canceled')} canceladas`)
        : h('p', { class: 'small muted' }, pr.name === 'stripe' ? 'Agrega STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET en .env y reinicia (./riverrun restart).' : 'Agrega MERCADOPAGO_ACCESS_TOKEN y MERCADOPAGO_WEBHOOK_SECRET en .env y reinicia (./riverrun restart).'),
      h('div', { class: 'small' }, 'Dirección de avisos (webhook):'),
      h('div', { class: 'row' }, h('code', { style: 'word-break:break-all' }, pr.webhook_url), copy(pr.webhook_url)),
      h('p', { class: 'small muted' }, pr.name === 'stripe' ? 'En Stripe → Desarrolladores → Webhooks: eventos checkout.session.completed, customer.subscription.*, invoice.paid, invoice.payment_failed, invoice.payment_action_required (el banco pide confirmar), charge.refunded (reembolsos) y charge.dispute.* (contracargos).' : 'En Mercado Pago → Tus integraciones → Webhooks: eventos "Planes y suscripciones" (preapproval y pagos autorizados) y "Pagos" (reembolsos y contracargos).')))),
    h('p', { class: 'muted' }, 'Además, cada suscripción se compara con el proveedor una vez al día: un aviso perdido no deja un cobro, una pausa o una reactivación sin aplicar.'),
    ...(ov.monthly_revenue.length ? [h('p', {}, h('strong', {}, 'Ingreso mensual recurrente: '), ov.monthly_revenue.map((m) => `${m.amount.toLocaleString('es-MX')} ${m.currency}`).join(' · '))] : []),
    h('h2', {}, 'Planes'),
    h('p', { class: 'muted' }, `Si un cobro falla, la cuenta sigue funcionando ${ov.grace_days} días y luego se pausa sola; al pagar, se reactiva sola.`),
    ...plans.map((p) => editor(p, false)),
    h('h2', {}, 'Agregar plan'),
    editor(blank, true));
}
