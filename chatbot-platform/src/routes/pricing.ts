/**
 * Página pública de precios (/precios): los planes que se pueden contratar, con precio + IVA y lo que incluyen, y el botón
 * para crear la cuenta con ese plan elegido. HTML del servidor, sin JavaScript, con la marca del dominio de la visita.
 */
import type { FastifyInstance } from 'fastify';
import { brandByDomain, hostOf, publicBrand } from '../brands.js';
import { config } from '../config.js';
import { offeredPlans } from './billing.js';
import { cardRequired } from '../billing/card-check.js';
import { privacyUrl } from './self-service.js';
import { publicPalette } from '../public-colors.js';
import { visitorLang, type Lang } from '../locale.js';
import { toEnglish } from '../mail-language.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const HEX = /^#[0-9a-f]{3,8}$/i;

/** Los textos de la página en cada idioma. En inglés se ven los planes en dólares (plansForLanguage). */
const COPY = {
  es: {
    locale: 'es-MX',
    month: 'mes', year: 'año',
    limits: [
      ['messages_per_month', 'mensajes del asistente al mes', 'mensaje del asistente al mes'],
      ['channels', 'canales (WhatsApp, Instagram…)', 'canal (WhatsApp, Instagram…)'],
      ['chatbots', 'asistentes', 'asistente'],
      ['users', 'personas del equipo', 'persona del equipo'],
      ['social_accounts', 'redes sociales conectadas', 'red social conectada'],
      ['storage_mb', 'MB para tus archivos', 'MB para tus archivos'],
    ] as [string, string, string][],
    unlimitedMessages: 'Mensajes del asistente sin límite',
    noLimits: 'Sin límites de uso',
    buy: 'Contratar', buyPlan: (n: string) => ` el plan ${n}`,
    startTrial: 'Empezar prueba gratis',
    tax: ' + IVA',
    totalWithTax: (total: string, cur: string, per: string) => `Total con IVA: $${total} ${cur} al ${per}`,
    contact: (who: string) => `Escríbenos a <strong>${who}</strong>.`,
    faqCard: (days: number) => `Sí. Tu prueba de ${days} días empieza al agregar tu tarjeta, y no se cobra nada hasta que termina; si cancelas antes desde Mi plan, no se cobra.`,
    faqNoCard: (days: number) => `No. Tienes ${days} días gratis para configurar y probar tu asistente; eliges plan cuando quieras.`,
    faqCardQ: '¿Necesito tarjeta para probar?',
    faqTaxQ: '¿El precio incluye IVA?',
    faqTax: (taxed: boolean) => (taxed ? 'No: los precios en pesos son más IVA. Antes de pagar ves el total con IVA.' : 'Ves el total exacto antes de pagar.'),
    faqPayQ: '¿Cómo pago?',
    faqPay: (mp: boolean) => `Con tarjeta en la página segura de Stripe${mp ? ' o de Mercado Pago' : ''}. Nosotros nunca vemos los datos de tu tarjeta.`,
    faqCancelQ: '¿Puedo cancelar?',
    faqCancel: 'Sí, cuando quieras desde tu panel. Sigues usando tu plan hasta el final del periodo pagado.',
    title: 'Precios',
    description: (n: string) => `Planes y precios de ${n}: tu asistente responde por WhatsApp las 24 horas.`,
    lead: 'Tu asistente responde por WhatsApp las 24 horas, agenda citas y envía cotizaciones.',
    leadTrial: (days: number, card: boolean) => ` Empieza con ${days} días gratis${card ? ': no se cobra nada hasta que terminan' : ', sin tarjeta'}.`,
    tryFree: (days: number) => `Probar ${days} días gratis`,
    closed: 'Por ahora el registro está cerrado.',
    soon: 'Pronto publicaremos nuestros planes.',
    faq: 'Preguntas frecuentes',
    login: 'Ya tengo cuenta', terms: 'Términos', privacy: 'Aviso de privacidad', dataProtection: 'Protección de datos',
    help: 'Ayuda', status: 'Estado del servicio', write: 'Escríbenos', contactLabel: 'Contacto',
  },
  en: {
    locale: 'en-US',
    month: 'month', year: 'year',
    limits: [
      ['messages_per_month', 'assistant messages per month', 'assistant message per month'],
      ['channels', 'channels (WhatsApp, Instagram…)', 'channel (WhatsApp, Instagram…)'],
      ['chatbots', 'assistants', 'assistant'],
      ['users', 'team members', 'team member'],
      ['social_accounts', 'connected social accounts', 'connected social account'],
      ['storage_mb', 'MB for your files', 'MB for your files'],
    ] as [string, string, string][],
    unlimitedMessages: 'Unlimited assistant messages',
    noLimits: 'No usage limits',
    buy: 'Get started', buyPlan: (n: string) => ` with the ${n} plan`,
    startTrial: 'Start free trial',
    tax: ' + tax',
    totalWithTax: (total: string, cur: string, per: string) => `Total with tax: $${total} ${cur} per ${per}`,
    contact: (who: string) => `Email us at <strong>${who}</strong>.`,
    faqCard: (days: number) => `Yes. Your ${days}-day trial starts when you add your card, and nothing is charged until it ends; cancel before then from My plan and you won't be charged.`,
    faqNoCard: (days: number) => `No. You get ${days} free days to set up and try your assistant; pick a plan whenever you're ready.`,
    faqCardQ: 'Do I need a card to try it?',
    faqTaxQ: 'Does the price include tax?',
    faqTax: (taxed: boolean) => (taxed ? 'No: prices in Mexican pesos are plus VAT (IVA). You see the total before you pay.' : 'You see the exact total before you pay.'),
    faqPayQ: 'How do I pay?',
    faqPay: (mp: boolean) => `By card on the secure page of Stripe${mp ? ' or Mercado Pago' : ''}. We never see your card details.`,
    faqCancelQ: 'Can I cancel?',
    faqCancel: 'Yes, anytime from your dashboard. You keep your plan until the end of the period you paid for.',
    title: 'Pricing',
    description: (n: string) => `${n} plans and pricing: your assistant answers on WhatsApp 24/7.`,
    lead: 'Your assistant answers on WhatsApp 24/7, books appointments and sends quotes.',
    leadTrial: (days: number, card: boolean) => ` Start with ${days} free days${card ? ': nothing is charged until they end' : ', no card needed'}.`,
    tryFree: (days: number) => `Try it free for ${days} days`,
    closed: 'Sign-ups are closed for now.',
    soon: "We'll publish our plans soon.",
    faq: 'Frequently asked questions',
    login: 'I have an account', terms: 'Terms', privacy: 'Privacy notice', dataProtection: 'Data protection',
    help: 'Help', status: 'Service status', write: 'Contact us', contactLabel: 'Contact',
  },
} as const;
type Copy = (typeof COPY)[Lang];

type Offered = Awaited<ReturnType<typeof offeredPlans>>[number];

interface PageOpts { signup: boolean; trialDays: number; t: Copy }

/**
 * Botón de cada plan: contratarlo (registro con el plan elegido, que pasa al pago) si se puede pagar en línea; si no, la
 * prueba gratis sin plan.
 */
function planCta(p: Offered, o: PageOpts) {
  if (!o.signup) return '';
  if (p.providers.length) return `<a class="btn" href="/#/registro?plan=${encodeURIComponent(p.key)}">${o.t.buy}<span class="sr">${esc(o.t.buyPlan(p.name))}</span></a>`;
  return o.trialDays > 0 ? `<a class="btn ghost" href="/#/registro">${o.t.startTrial}</a>` : '';
}

function planCard(p: Offered, o: PageOpts) {
  const { t } = o;
  const amount = (n: number) => new Intl.NumberFormat(t.locale, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
  const per = p.billing_interval === 'year' ? t.year : t.month;
  const lim = (p.limits ?? {}) as Record<string, number | null | undefined>;
  const limits = t.limits.filter(([k]) => lim[k]).map(([k, pl, sg]) => `<li>${esc(Number(lim[k]).toLocaleString(t.locale))} ${lim[k] === 1 ? sg : pl}</li>`);
  // Un plan con otros límites pero sin tope de mensajes lo dice (si no tiene ninguno, sale «Sin límites de uso»).
  if (limits.length && !lim.messages_per_month) limits.unshift(`<li>${t.unlimitedMessages}</li>`);
  return `<article class="plan">
  <h2>${esc(p.name)}</h2>
  <p class="price"><strong>$${esc(amount(p.price))}</strong> <span>${esc(p.currency)}${p.tax_percent ? t.tax : ''} / ${per}</span></p>
  ${p.tax_percent ? `<p class="muted small">${esc(t.totalWithTax(amount(p.total), p.currency, per))}</p>` : ''}
  ${p.description ? `<p>${esc(p.description)}</p>` : ''}
  <ul>${limits.length ? limits.join('') : `<li>${t.noLimits}</li>`}</ul>
  ${planCta(p, o)}
</article>`;
}

export function pricingPage(o: { brand: ReturnType<typeof publicBrand>; plans: Offered[]; trialDays: number; signup: boolean; support: string; terms: string; privacy: string; cardRequired?: boolean; lang?: Lang }) {
  const lang: Lang = o.lang ?? 'es';
  const t = COPY[lang];
  const name = o.brand.name;
  const opts: PageOpts = { signup: o.signup, trialDays: o.trialDays, t };
  // Colores con contraste AA en los dos temas, también con el color de una marca blanca.
  const palette = publicPalette(HEX.test(o.brand.color) ? o.brand.color : '');
  const contact = o.support ? t.contact(esc(o.support)) : '';
  const mercadoPago = o.plans.some((p) => p.providers.some((x) => x.name === 'mercadopago'));
  const faq: [string, string][] = [
    ...(o.trialDays > 0 ? [[t.faqCardQ, o.cardRequired ? t.faqCard(o.trialDays) : t.faqNoCard(o.trialDays)] as [string, string]] : []),
    [t.faqTaxQ, t.faqTax(o.plans.some((p) => p.tax_percent))],
    [t.faqPayQ, t.faqPay(lang === 'es' || mercadoPago)],
    [t.faqCancelQ, t.faqCancel],
  ];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t.title} — ${esc(name)}</title>
<meta name="description" content="${esc(t.description(name))}" />
<style>
  :root { ${palette.light} --text: #101828; --muted: #475467; --border: #e4e7ec; --bg: #f2f4f7; --panel: #fff; }
  @media (prefers-color-scheme: dark) { :root { ${palette.dark} --text: #e4e7ec; --muted: #98a2b3; --border: #252b37; --bg: #0c111d; --panel: #161b26; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 24px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; margin-bottom: 28px; }
  .brand img { height: 36px; width: auto; }
  h1 { font-size: 32px; margin: 0 0 8px; }
  .lead { color: var(--muted); font-size: 18px; margin: 0 0 28px; max-width: 640px; }
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .plan { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 22px; display: flex; flex-direction: column; gap: 6px; }
  .plan h2 { font-size: 20px; margin: 0; }
  .price { margin: 4px 0 0; }
  .price strong { font-size: 32px; }
  .price span { color: var(--muted); }
  .plan ul { padding-left: 20px; margin: 8px 0 16px; flex: 1; }
  .btn { display: block; text-align: center; background: var(--accent); color: var(--accent-ink); padding: 11px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; }
  .btn.ghost { background: transparent; color: var(--link); border: 1px solid var(--link); }
  .hero { margin: 0 0 28px; }
  .hero .btn { display: inline-block; padding: 12px 22px; }
  .btn:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .muted { color: var(--muted); }
  .small { font-size: 14px; margin: 0; }
  section.faq { margin-top: 40px; display: grid; gap: 12px; }
  section.faq h2 { font-size: 22px; margin: 0 0 4px; }
  details { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  summary { cursor: pointer; font-weight: 600; }
  footer { max-width: 1040px; margin: 16px auto 0; padding: 0 16px 48px; color: var(--muted); font-size: 14px; display: flex; gap: 16px; flex-wrap: wrap; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <div class="brand">${o.brand.logo ? `<img src="${esc(o.brand.logo)}" alt="" />` : ''}<span>${esc(name)}</span></div>
  <h1>${t.title}</h1>
  <p class="lead">${t.lead}${o.trialDays > 0 ? t.leadTrial(o.trialDays, !!o.cardRequired) : ''}</p>
  ${o.signup && o.trialDays > 0 ? `<p class="hero"><a class="btn" href="/#/registro">${t.tryFree(o.trialDays)}</a></p>` : ''}
  ${o.plans.length
    ? `<div class="plans">${o.plans.map((p) => planCard(p, opts)).join('\n')}</div>
  ${o.signup ? '' : `<p class="muted">${t.closed} ${contact}</p>`}`
    : `<p>${t.soon} ${contact}</p>`}
  <section class="faq" aria-labelledby="faq">
    <h2 id="faq">${t.faq}</h2>
    ${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n    ')}
  </section>
</main>
<footer>
    <a href="/#/login">${t.login}</a>
    ${o.terms ? `<a href="${esc(o.terms)}">${t.terms}</a>` : ''}
    ${o.privacy ? `<a href="${esc(o.privacy)}">${t.privacy}</a>` : ''}
    <a href="/proteccion-de-datos">${t.dataProtection}</a>
    <a href="/ayuda.html">${t.help}</a>
    <a href="/estado">${t.status}</a>
    <a href="/contacto">${t.write}</a>
    ${o.support ? `<span>${t.contactLabel}: ${esc(o.support)}</span>` : ''}
</footer>
</body>
</html>`;
}

export async function pricingRoutes(app: FastifyInstance) {
  app.get('/precios', async (req, reply) => {
    const host = hostOf(req);
    const own = host && host !== new URL(config.publicBaseUrl).hostname ? await brandByDomain(host) : null;
    const lang = visitorLang(req);
    const plans = await offeredPlans(undefined, lang);
    // La descripción del plan se escribe en español; en inglés sale con el diccionario del panel.
    const shown = lang === 'en' ? await Promise.all(plans.map(async (p) => ({ ...p, description: p.description ? await toEnglish(p.description) : '' }))) : plans;
    const html = pricingPage({
      brand: publicBrand(own),
      plans: shown,
      trialDays: Math.max(0, config.signup.trialDays),
      signup: config.signup.enabled,
      support: own?.support_email || config.signup.supportContact,
      terms: config.signup.termsUrl,
      privacy: privacyUrl(),
      // Con cobro en línea, la prueba empieza al agregar la tarjeta (etapa 3a): la página no debe decir «sin tarjeta».
      cardRequired: await cardRequired(),
      lang,
    });
    // Cada dominio ve su marca y cada visita su idioma: un caché intermedio no debe mezclarlos.
    return reply.header('cache-control', 'public, max-age=300').header('vary', 'Host, Cookie, Accept-Language').type('text/html; charset=utf-8').send(html);
  });
}
