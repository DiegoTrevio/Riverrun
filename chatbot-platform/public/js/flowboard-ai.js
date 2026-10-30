import { api, h, toast } from './core.js';
import { icon } from './icons.js';
import { aiLock } from './session.js';

/*
 * Crear o cambiar un flujo describiéndolo: una caja para escribir la idea, con una foto opcional (se elige, se pega
 * con Ctrl+V o se arrastra encima). El servidor arma el lienzo con la IA; aquí solo se pide y se muestra el resultado.
 */

const IMAGE_MAX = 8_000_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Pide el flujo a la IA. Con `board` (el lienzo abierto) devuelve ese mismo lienzo con el cambio aplicado. */
export function requestDesign({ url, idea, file, board, name }) {
  const form = new FormData();
  form.append('idea', idea);
  if (name) form.append('name', name);
  if (board) form.append('board', JSON.stringify(board));
  if (file) form.append('file', file, file.name || 'imagen.png');
  return api('POST', url, form, true);
}

/** Lo que la IA hizo, en palabras: el resumen, lo que falta completar y, si quedó algo, cuántos pendientes hay. */
export function aiResult({ summary, review = [], errors = 0, title = 'Listo', onProblems, onUndo }) {
  return h('div', { class: 'ai-result', role: 'status' },
    h('p', { class: 'ai-result-head' }, icon('check', 16), h('strong', {}, title)),
    summary ? h('p', { class: 'ai-result-text' }, summary) : null,
    review.length ? [h('p', { class: 'ai-result-sub small' }, 'Para completar'), h('ul', { class: 'ai-review' }, review.map((r) => h('li', {}, r)))] : null,
    errors ? h('p', { class: 'ai-result-warn small' }, icon('alert', 14), `${errors} ${errors === 1 ? 'pendiente' : 'pendientes'} antes de publicar.`) : null,
    (errors && onProblems) || onUndo ? h('div', { class: 'row' },
      errors && onProblems ? h('button', { type: 'button', class: 'small', onclick: onProblems }, 'Ver pendientes') : null,
      onUndo ? h('button', { type: 'button', class: 'small', onclick: onUndo }, icon('undo', 14), 'Deshacer el cambio') : null) : null);
}

/**
 * Caja para escribir la idea (o el cambio) con una foto opcional. `onSubmit({ idea, file })` hace el trabajo; mientras
 * tanto la caja dice en qué va, y si falla muestra el error sin perder lo escrito.
 */
export function ideaComposer({ id, label, placeholder, examples = [], submit, steps = [], onSubmit }) {
  let file = null;
  let preview = '';
  let busy = false;
  let ticker = 0;
  const hintId = `${id}-hint`;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`; };
  const ta = h('textarea', {
    id, rows: 3, maxlength: 4000, placeholder, 'aria-describedby': hintId,
    oninput: grow,
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } },
    onpaste: (e) => {
      const pasted = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (pasted) { e.preventDefault(); attach(pasted); }
    },
  });
  const input = h('input', { type: 'file', hidden: true, accept: '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp',
    onchange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attach(f); } });
  const chip = h('div', { class: 'ai-file', hidden: true });
  const pickLabel = h('span', {}, 'Subir imagen');
  const pickBtn = h('button', { type: 'button', class: 'small ai-pick', onclick: () => input.click() }, icon('image', 16), pickLabel);
  const status = h('p', { class: 'ai-status small', role: 'status', 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'primary ai-go', onclick: () => go() }, icon('wand', 16), h('span', {}, submit));

  function say(text, kind = '') { status.textContent = text; status.className = `ai-status small${kind ? ` ${kind}` : ''}`; }
  function attach(f) {
    const heic = /\.hei[cf]$/i.test(f.name || '') || /hei[cf]/i.test(f.type);
    if (heic || !IMAGE_TYPES.has(f.type)) { say(heic ? 'Esa foto está en formato HEIC: compártela como JPG o toma una captura de pantalla.' : 'Sube una foto JPG, PNG o WEBP.', 'err'); return; }
    if (f.size > IMAGE_MAX) { say('La imagen pesa más de 8 MB: toma una captura o guárdala más pequeña.', 'err'); return; }
    file = f;
    if (preview) URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(f);
    chip.hidden = false;
    chip.replaceChildren(
      h('img', { src: preview, alt: '' }),
      h('span', { class: 'ai-file-name small' }, f.name || 'Imagen pegada'),
      h('button', { type: 'button', class: 'fb-icon', 'aria-label': 'Quitar la imagen', title: 'Quitar', onclick: () => { clearFile(); ta.focus(); } }, icon('x', 16)));
    pickLabel.textContent = 'Cambiar imagen';
    say('Imagen lista. Si quieres, escribe qué hacer con ella.');
  }
  function clearFile() {
    file = null;
    if (preview) URL.revokeObjectURL(preview);
    preview = '';
    chip.hidden = true;
    chip.replaceChildren();
    pickLabel.textContent = 'Subir imagen';
  }
  function setBusy(on) {
    busy = on;
    box.setAttribute('aria-busy', String(on));
    btn.disabled = on; pickBtn.disabled = on; ta.readOnly = on;
    clearInterval(ticker);
    if (on) {
      let i = 0;
      say(steps[0] ?? 'Trabajando…', 'busy');
      ticker = setInterval(() => { i = Math.min(i + 1, steps.length - 1); say(steps[i] ?? 'Trabajando…', 'busy'); }, 2600);
    }
  }
  async function go() {
    if (busy) return;
    const idea = ta.value.trim();
    if (!idea && !file) { say('Escribe tu idea o sube una imagen.', 'err'); ta.focus(); return; }
    setBusy(true);
    try {
      await onSubmit({ idea, file });
      if (box.isConnected) { setBusy(false); say(''); }
    } catch (e) {
      setBusy(false);
      say(e.message || 'No se pudo. Intenta de nuevo.', 'err');
      toast(e.message || 'No se pudo. Intenta de nuevo.', true);
    } finally {
      if (!box.isConnected) clearInterval(ticker);
    }
  }

  const box = h('div', { class: 'ai-compose',
    ondragover: (e) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) { e.preventDefault(); box.classList.add('is-drop'); } },
    ondragleave: (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('is-drop'); },
    ondrop: (e) => { const f = e.dataTransfer?.files?.[0]; box.classList.remove('is-drop'); if (f) { e.preventDefault(); attach(f); } } },
    h('label', { class: 'ai-label', for: id }, label),
    ta,
    chip,
    h('div', { class: 'ai-bar' },
      pickBtn, input,
      h('span', { class: 'ai-hint small muted', id: hintId }, 'Puedes pegar una captura (Ctrl+V) o arrastrar una foto aquí.'),
      aiLock(btn)),
    examples.length ? h('div', { class: 'ai-examples' },
      h('span', { class: 'small muted' }, 'Ejemplos:'),
      examples.map(([title, idea]) => h('button', { type: 'button', class: 'ai-example', onclick: () => { ta.value = idea; grow(); ta.focus(); say(''); } }, title))) : null,
    status);

  return {
    el: box,
    focus: () => ta.focus(),
    reset: () => { ta.value = ''; grow(); clearFile(); },
  };
}
