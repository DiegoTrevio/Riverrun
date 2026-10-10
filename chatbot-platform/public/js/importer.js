import { api, area, field, fill, h, run, text, toast } from './core.js';
import { render } from './main.js';

/* ------------------------------ Importar información del negocio ------------------------------ */

const SECTION_LABELS = { catalog: 'Productos o servicios con precios', hours: 'Horarios', location: 'Ubicación y contacto', faq: 'Preguntas frecuentes', other: 'Otra información' };

/**
 * Tarjeta "Llena todo por mí": la persona da su página web, sube un PDF, una foto o un CSV, o pega texto;
 * la IA lo ordena en secciones y se devuelve a `onResult` para que lo revise antes de guardar.
 */
export function importCard({ endpoint, url = '', onResult, title = '⚡ Llena todo por mí', intro, button = 'Leer mi información' }) {
  const f = { url, text: '', source: url ? 'url' : 'file' };
  const source = h('select', { 'aria-label': 'Fuente de información', onchange: (e) => { f.source = e.target.value; updateSource(); } }, [['file', 'Archivo'], ['url', 'Página web'], ['text', 'Texto']].map(([v, label]) => h('option', { value: v, selected: v === f.source }, label)));
  let file = null;
  const fileName = h('span', { class: 'small muted' });
  const fileInput = h('input', {
    type: 'file', hidden: true, accept: '.pdf,.csv,.tsv,.txt,.md,image/jpeg,image/png,image/webp',
    onchange: (e) => { file = e.target.files[0] || null; fileName.textContent = file ? `📎 ${file.name}` : ''; },
  });
  const status = h('span', { class: 'small muted' });
  const btn = h('button', { class: 'primary' }, button);
  btn.addEventListener('click', async () => {
    if ((f.source === 'file' && !file) || (f.source === 'url' && !f.url.trim()) || (f.source === 'text' && f.text.trim().length < 20)) return toast('Pega la dirección de tu página, sube un archivo o pega tu información', true);
    const form = new FormData();
    if (f.source === 'file') form.append('file', file);
    else if (f.source === 'url') form.append('url', f.url.trim());
    else form.append('text', f.text);
    btn.disabled = true;
    status.textContent = 'Leyendo tu información… puede tardar hasta un minuto.';
    const r = await run(() => api('POST', endpoint, form, true));
    btn.disabled = false;
    status.textContent = '';
    if (r) { r.source_url = f.source === 'url' ? f.url.trim() : null; await onResult(r); }
  });
  const website = field('Dirección web', text(f, 'url', { type: 'url', placeholder: 'https://www.minegocio.com' }));
  const upload = h('div', { class: 'row' }, h('button', { onclick: () => fileInput.click() }, '📎 Elegir archivo'), fileInput, fileName, h('button', { class: 'small', onclick: () => { file = null; fileInput.value = ''; fileName.textContent = ''; } }, 'Quitar archivo'));
  const pasted = field('Información del negocio', area(f, 'text', { big: true, placeholder: 'Pega tu menú, precios, horarios…', maxlength: 50000 }));
  function updateSource() { website.hidden = f.source !== 'url'; upload.hidden = f.source !== 'file'; pasted.hidden = f.source !== 'text'; }
  updateSource();
  return h('div', { class: 'card import-card' }, h('h2', { style: 'margin-top:0' }, title), h('p', { class: 'muted' }, intro || 'Elige una fuente. Ordenamos la información para que la revises antes de guardarla.'), field('Leer información desde', source), website, upload, pasted, h('div', { class: 'row' }, btn, status));
}

/** Propuesta de importación (en la pestaña Conocimiento): se revisa y se guarda con un clic. */
export function importPreview(box, bot, data) {
  const sections = { ...data.sections };
  fill(box, h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Revisa lo que encontramos'),
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
  return api('POST', `/api/chatbots/${bot.id}/knowledge/import-reviewed`, { sections, source_url: sourceUrl || null });
}
