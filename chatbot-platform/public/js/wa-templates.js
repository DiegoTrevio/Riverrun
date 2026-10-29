import { api, area, confirmAction, field, fill, fmtDate, h, run, select, text } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';

/**
 * Plantillas de WhatsApp de un número (API oficial por Zernio). Meta solo deja escribir dentro de las 24 h posteriores
 * al último mensaje del cliente; después, solo con una plantilla que Meta aprobó. Aquí se ven, se crean y se borran.
 */

const STATUS = {
  APPROVED: ['green', 'Aprobada'], PENDING: ['orange', 'En revisión de Meta'], REJECTED: ['red', 'Rechazada'], PAUSED: ['orange', 'Pausada por Meta'],
  DISABLED: ['red', 'Desactivada'], IN_APPEAL: ['orange', 'En apelación'], PENDING_DELETION: ['red', 'Borrándose'],
};
const CATEGORY = { UTILITY: 'Avisos y seguimiento', MARKETING: 'Promoción', AUTHENTICATION: 'Código de acceso' };
const varsIn = (body) => { const n = [...String(body).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])); return n.length ? Math.max(...n) : 0; };

export async function viewWaTemplates(root, socialId) {
  const [data, list] = await Promise.all([api('GET', withAcct('/api/social-accounts')), api('GET', withAcct(`/api/wa-templates?social_account_id=${encodeURIComponent(socialId)}`))]);
  if (!root.isConnected) return;
  const wa = data.accounts.find((a) => a.id === socialId && a.platform === 'whatsapp');
  root.append(h('a', { href: '#/redes', class: 'breadcrumb' }, '← Redes sociales'), h('h1', {}, 'Plantillas de WhatsApp'));
  if (!wa) {
    root.append(h('p', { class: 'banner warn' }, 'Ese número de WhatsApp ya no está conectado.'));
    return;
  }
  root.append(h('p', { class: 'muted' },
    `Número: ${wa.display_name || wa.username || 'WhatsApp'}. Pasadas 24 h desde el último mensaje del cliente, WhatsApp solo deja escribirle con una plantilla aprobada por Meta (la revisión tarda de minutos a 24 h; te avisamos).`));

  const card = (t) => {
    const [color, label] = STATUS[t.status] || ['', t.status];
    return h('div', { class: 'list-item' },
      h('div', { class: 'row between' },
        h('div', { style: 'min-width:0' }, h('strong', {}, t.name), h('span', { class: 'small muted' }, ` · ${t.language} · ${CATEGORY[t.category] || t.category}`)),
        h('span', { class: `badge ${color}` }, label)),
      h('p', { style: 'white-space:pre-wrap;margin:8px 0' }, t.body || '(sin texto)'),
      t.status === 'REJECTED' && t.rejection_reason ? h('p', { class: 'small error' }, `Motivo de Meta: ${t.rejection_reason}`) : null,
      t.status === 'APPROVED' && !t.sendable ? h('p', { class: 'small muted' }, 'Tiene foto o variables en el encabezado: úsala desde Meta.') : null,
      h('div', { class: 'row' },
        h('span', { class: 'small muted' }, t.variables ? `${t.variables} variable(s) · ` : '', `Actualizada ${fmtDate(t.updated_at)}`),
        h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmAction(`¿Borrar la plantilla "${t.name}" (${t.language})? Meta no deja volver a usar ese nombre durante 30 días.`))) return;
          if (await run(() => api('DELETE', withAcct(`/api/wa-templates/${t.id}`)), 'Plantilla borrada')) render();
        } }, 'Borrar')));
  };

  // Nueva plantilla.
  const m = { social_account_id: socialId, name: '', category: 'UTILITY', language: 'es_MX', header: '', body: '', footer: '', examples: [], quick: ['', '', ''], link_text: '', link_url: '' };
  const examples = h('div');
  const drawExamples = () => {
    const n = varsIn(m.body);
    m.examples = Array.from({ length: n }, (_, i) => m.examples[i] ?? '');
    fill(examples, n ? field(`Ejemplos para Meta (${n})`, h('div', { class: 'stack' }, m.examples.map((_, i) =>
      h('input', { value: m.examples[i], placeholder: `Ejemplo de {{${i + 1}}}`, 'aria-label': `Ejemplo de la variable ${i + 1}`, oninput: (e) => (m.examples[i] = e.target.value) }))),
    'Meta los usa para revisar la plantilla. Al enviarla, cada variable se llena con el dato que elijas (p. ej. {{nombre}}).') : null);
  };
  drawExamples();
  const create = async () => {
    const buttons = [...m.quick.filter((q) => q.trim()).map((q) => ({ type: 'quick_reply', text: q.trim() })), ...(m.link_text.trim() && m.link_url.trim() ? [{ type: 'url', text: m.link_text.trim(), url: m.link_url.trim() }] : [])];
    const body = { social_account_id: socialId, name: m.name.trim(), category: m.category, language: m.language, header: m.header, body: m.body, footer: m.footer, examples: m.examples, buttons };
    if (await run(() => api('POST', withAcct('/api/wa-templates'), body), 'Enviada a revisión de Meta')) render();
  };

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Tus plantillas'),
        h('button', { class: 'small', onclick: async () => { const r = await run(() => api('POST', withAcct('/api/wa-templates/sync'), { social_account_id: socialId })); if (r) render(); } }, 'Traer de Meta')),
      list.length ? list.map(card) : h('p', { class: 'muted' }, 'Todavía no hay plantillas. Crea una abajo o pulsa "Traer de Meta" si ya las tienes en tu cuenta de Meta.')),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Nueva plantilla'),
      h('div', { class: 'grid' },
        field('Nombre', text(m, 'name', { placeholder: 'recordatorio_cita', maxlength: 100 }), 'En minúsculas, sin espacios ni acentos (usa _).'),
        field('Tipo', select(m, 'category', [['UTILITY', 'Avisos y seguimiento (citas, pedidos, recordatorios)'], ['MARKETING', 'Promoción (ofertas y novedades)']]), 'Meta cobra y revisa distinto cada tipo.'),
        field('Idioma', select(m, 'language', [['es_MX', 'Español (México)'], ['es', 'Español'], ['es_ES', 'Español (España)'], ['en_US', 'Inglés (EE. UU.)']]))),
      field('Encabezado (opcional)', text(m, 'header', { maxlength: 60 })),
      field('Mensaje', area(m, 'body', { maxlength: 1024, placeholder: 'Hola {{1}}, te recordamos tu cita del {{2}}. ¿Nos confirmas?', oninput: drawExamples }), 'Usa {{1}}, {{2}}… para lo que cambia en cada cliente.'),
      examples,
      field('Pie (opcional)', text(m, 'footer', { maxlength: 60, placeholder: 'Responde BAJA para no recibir más' })),
      h('details', {}, h('summary', {}, 'Botones (opcional)'),
        h('div', { class: 'grid' },
          ...m.quick.map((_, i) => field(`Respuesta rápida ${i + 1}`, h('input', { maxlength: 25, value: '', oninput: (e) => (m.quick[i] = e.target.value) }))),
          field('Botón de enlace: texto', text(m, 'link_text', { maxlength: 25, placeholder: 'Ver mi pedido' })),
          field('Botón de enlace: dirección', text(m, 'link_url', { placeholder: 'https://…', type: 'url' })))),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: create }, 'Enviar a revisión'))),
  );
}
