import { api, area, field, fill, h, run, text, toast } from './core.js';
import { render } from './main.js';

/* ------------------------------ Importar información del negocio ------------------------------ */

const SECTION_LABELS = { catalog: 'Productos o servicios con precios', hours: 'Horarios', location: 'Ubicación y contacto', faq: 'Preguntas frecuentes', other: 'Otra información' };

/**
 * Tarjeta "Llena todo por mí": la persona da su página web, sube un PDF, una foto o un CSV, o pega texto;
 * la IA lo ordena en secciones y se devuelve a `onResult` para que lo revise antes de guardar.
 */
export function importCard({ endpoint, url = '', onResult, title = '⚡ Llena todo por mí', intro, button = 'Leer mi información' }) {
  const f = { url, text: '' };
  let file = null;
  const fileName = h('span', { class: 'small muted' });
  const fileInput = h('input', {
    type: 'file', hidden: true, accept: '.pdf,.csv,.tsv,.txt,.md,image/jpeg,image/png,image/webp',
    onchange: (e) => { file = e.target.files[0] || null; fileName.textContent = file ? `📎 ${file.name}` : ''; },
  });
  const status = h('span', { class: 'small muted' });
  const btn = h('button', { class: 'primary' }, button);
  btn.addEventListener('click', async () => {
    if (!file && !f.url.trim() && f.text.trim().length < 20) return toast('Pega la dirección de tu página, sube un archivo o pega tu información', true);
    const form = new FormData();
    if (file) form.append('file', file);
    else if (f.url.trim()) form.append('url', f.url.trim());
    else form.append('text', f.text);
    btn.disabled = true;
    status.textContent = 'Leyendo tu información… puede tardar hasta un minuto.';
    const r = await run(() => api('POST', endpoint, form, true));
    btn.disabled = false;
    status.textContent = '';
    if (r) { r.source_url = file ? null : f.url.trim() || null; await onResult(r); }
  });
  return h('div', { class: 'card import-card' },
    h('h3', { style: 'margin-top:0' }, title),
    h('p', { class: 'muted' }, intro || 'Pega la dirección de tu página web o de tu menú, o sube tu lista de precios (PDF, foto, CSV). Armamos la información por ti y tú solo la revisas.'),
    field('Dirección web (página, menú, Google Sheets compartido)', text(f, 'url', { placeholder: 'https://www.minegocio.com' })),
    h('div', { class: 'row' },
      h('button', { onclick: () => fileInput.click() }, '📎 Subir PDF, foto o CSV'), fileInput, fileName),
    h('details', {}, h('summary', {}, 'O pega aquí tu información'), area(f, 'text', { big: true, placeholder: 'Pega tu menú, lista de precios, horarios…' })),
    h('div', { class: 'row', style: 'margin-top:10px' }, btn, status));
}

/** Propuesta de importación (en la pestaña Conocimiento): se revisa y se guarda con un clic. */
export function importPreview(box, bot, data) {
  const sections = { ...data.sections };
  fill(box, h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Revisa lo que encontramos'),
    h('p', { class: 'muted' }, `Fuente: ${data.source}. Corrige lo que haga falta: al guardar reemplaza los temas con el mismo nombre. ${data.truncated ? 'La fuente era muy larga y solo se leyó el inicio. ' : ''}Nada se inventó: si falta algo, escríbelo aquí.`),
    Object.entries(SECTION_LABELS).map(([k, label]) => field(label, area(sections, k, { big: k === 'catalog' }))),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => {
        // Se guarda tal como quedó revisado, sin volver a leer la página.
        const saved = await run(() => saveImported(bot, sections, data.source_url), 'Información guardada ✅');
        if (saved) render();
      } }, 'Guardar'),
      h('button', { onclick: () => fill(box) }, 'Descartar'))));
}

async function saveImported(bot, sections, sourceUrl) {
  const cats = { catalog: ['precios', 'Productos, servicios y precios'], hours: ['horarios', 'Horarios'], location: ['ubicaciones', 'Ubicación y contacto'], faq: ['preguntas_frecuentes', 'Preguntas frecuentes'], other: ['general', 'Otra información'] };
  const items = await api('GET', `/api/chatbots/${bot.id}/knowledge`);
  for (const [k, [category, title]] of Object.entries(cats)) {
    const content = (sections[k] || '').trim();
    if (!content) continue;
    const prev = items.find((i) => i.title === title);
    const body = { category, title, content, active: true, always_include: k !== 'faq', source_url: sourceUrl || null };
    await (prev ? api('PUT', `/api/knowledge/${prev.id}`, body) : api('POST', `/api/chatbots/${bot.id}/knowledge`, body));
  }
  return true;
}
