/**
 * Página pública de precios (/precios): los planes que se pueden contratar, con precio + IVA y lo que incluyen, y el botón
 * para crear la cuenta con ese plan elegido. HTML del servidor, sin JavaScript, con la marca del dominio de la visita.
 */
import type { FastifyInstance } from 'fastify';
import { brandByDomain, hostOf, publicBrand } from '../brands.js';
import { config } from '../config.js';
import { offeredPlans } from './billing.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const amount = (n: number) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
const LIMITS: [string, string, string][] = [
  ['messages_per_month', 'mensajes del asistente al mes', 'mensaje del asistente al mes'],
  ['channels', 'canales (WhatsApp, Instagram…)', 'canal (WhatsApp, Instagram…)'],
  ['chatbots', 'asistentes', 'asistente'],
  ['users', 'personas del equipo', 'persona del equipo'],
  ['social_accounts', 'redes sociales conectadas', 'red social conectada'],
];
const HEX = /^#[0-9a-f]{3,8}$/i;

type Offered = Awaited<ReturnType<typeof offeredPlans>>[number];

/**
 * Botón de cada plan: contratarlo (registro con el plan elegido, que pasa al pago) si se puede pagar en línea; si no, la
 * prueba gratis sin plan.
 */
function planCta(p: Offered, o: { signup: boolean; trialDays: number }) {
  if (!o.signup) return '';
  if (p.providers.length) return `<a class="btn" href="/#/registro?plan=${encodeURIComponent(p.key)}">Contratar<span class="sr"> el plan ${esc(p.name)}</span></a>`;
  return o.trialDays > 0 ? `<a class="btn ghost" href="/#/registro">Empezar prueba gratis</a>` : '';
}

function planCard(p: Offered, o: { signup: boolean; trialDays: number }) {
  const per = p.billing_interval === 'year' ? 'año' : 'mes';
  const limits = LIMITS.filter(([k]) => p.limits?.[k]).map(([k, pl, sg]) => `<li>${esc(Number(p.limits[k]).toLocaleString('es-MX'))} ${p.limits[k] === 1 ? sg : pl}</li>`);
  return `<article class="plan">
  <h2>${esc(p.name)}</h2>
  <p class="price"><strong>$${esc(amount(p.price))}</strong> <span>${esc(p.currency)}${p.tax_percent ? ' + IVA' : ''} / ${per}</span></p>
  ${p.tax_percent ? `<p class="muted small">Total con IVA: $${esc(amount(p.total))} ${esc(p.currency)} al ${per}</p>` : ''}
  ${p.description ? `<p>${esc(p.description)}</p>` : ''}
  <ul>${limits.length ? limits.join('') : '<li>Sin límites de uso</li>'}</ul>
  ${planCta(p, o)}
</article>`;
}

export function pricingPage(o: { brand: ReturnType<typeof publicBrand>; plans: Offered[]; trialDays: number; signup: boolean; support: string; terms: string; privacy: string }) {
  const name = o.brand.name;
  const accent = HEX.test(o.brand.color) ? o.brand.color : '';
  const contact = o.support ? `Escríbenos a <strong>${esc(o.support)}</strong>.` : '';
  const faq: [string, string][] = [
    ...(o.trialDays > 0 ? [['¿Necesito tarjeta para probar?', `No. Tienes ${o.trialDays} días gratis para configurar y probar tu asistente; eliges plan cuando quieras.`] as [string, string]] : []),
    ['¿El precio incluye IVA?', o.plans.some((p) => p.tax_percent) ? 'No: los precios son más IVA. Antes de pagar ves el total con IVA.' : 'Ves el total exacto antes de pagar.'],
    ['¿Cómo pago?', 'Con tarjeta en la página segura de Stripe o de Mercado Pago. Nosotros nunca vemos los datos de tu tarjeta.'],
    ['¿Puedo cancelar?', 'Sí, cuando quieras desde tu panel. Sigues usando tu plan hasta el final del periodo pagado.'],
  ];
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Precios — ${esc(name)}</title>
<meta name="description" content="Planes y precios de ${esc(name)}: tu asistente responde por WhatsApp las 24 horas." />
<style>
  :root { --accent: ${accent || '#155eef'}; --text: #101828; --muted: #475467; --border: #e4e7ec; --bg: #f2f4f7; --panel: #fff; }
  @media (prefers-color-scheme: dark) { :root { ${accent ? '' : '--accent: #2f6fed;'} --text: #e4e7ec; --muted: #98a2b3; --border: #252b37; --bg: #0c111d; --panel: #161b26; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
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
  .btn { display: block; text-align: center; background: var(--accent); color: #fff; padding: 11px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; }
  .btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .hero { margin: 0 0 28px; }
  .hero .btn { display: inline-block; padding: 12px 22px; }
  .btn:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .muted { color: var(--muted); }
  .small { font-size: 14px; margin: 0; }
  section.faq { margin-top: 40px; display: grid; gap: 12px; }
  section.faq h2 { font-size: 22px; margin: 0 0 4px; }
  details { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  summary { cursor: pointer; font-weight: 600; }
  footer { margin-top: 40px; color: var(--muted); font-size: 14px; display: flex; gap: 16px; flex-wrap: wrap; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <div class="brand">${o.brand.logo ? `<img src="${esc(o.brand.logo)}" alt="" />` : ''}<span>${esc(name)}</span></div>
  <h1>Precios</h1>
  <p class="lead">Tu asistente responde por WhatsApp las 24 horas, agenda citas y envía cotizaciones.${o.trialDays > 0 ? ` Empieza con ${o.trialDays} días gratis, sin tarjeta.` : ''}</p>
  ${o.signup && o.trialDays > 0 ? `<p class="hero"><a class="btn" href="/#/registro">Probar ${o.trialDays} días gratis</a></p>` : ''}
  ${o.plans.length
    ? `<div class="plans">${o.plans.map((p) => planCard(p, o)).join('\n')}</div>
  ${o.signup ? '' : `<p class="muted">Por ahora el registro está cerrado. ${contact}</p>`}`
    : `<p>Pronto publicaremos nuestros planes. ${contact}</p>`}
  <section class="faq" aria-labelledby="faq">
    <h2 id="faq">Preguntas frecuentes</h2>
    ${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n    ')}
  </section>
  <footer>
    <a href="/#/login">Ya tengo cuenta</a>
    ${o.terms ? `<a href="${esc(o.terms)}">Términos</a>` : ''}
    ${o.privacy ? `<a href="${esc(o.privacy)}">Aviso de privacidad</a>` : ''}
    ${o.support ? `<span>Contacto: ${esc(o.support)}</span>` : ''}
  </footer>
</main>
</body>
</html>`;
}

export async function pricingRoutes(app: FastifyInstance) {
  app.get('/precios', async (req, reply) => {
    const host = hostOf(req);
    const own = host && host !== new URL(config.publicBaseUrl).hostname ? await brandByDomain(host) : null;
    const html = pricingPage({
      brand: publicBrand(own),
      plans: await offeredPlans(),
      trialDays: Math.max(0, config.signup.trialDays),
      signup: config.signup.enabled,
      support: own?.support_email || config.signup.supportContact,
      terms: config.signup.termsUrl,
      privacy: config.signup.privacyUrl,
    });
    // Cada dominio ve su marca: un caché intermedio no debe mezclarlas.
    return reply.header('cache-control', 'public, max-age=300').header('vary', 'Host').type('text/html; charset=utf-8').send(html);
  });
}
