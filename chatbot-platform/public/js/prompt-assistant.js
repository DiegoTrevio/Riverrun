import { api, h, toast } from './core.js';
import { icon } from './icons.js';

/*
 * Cambiar las instrucciones del agente escribiendo qué se quiere: «quita lo de envíos gratis y agrega que los domingos
 * cerramos». La IA propone el cambio sobre el texto (sin tocar lo demás), aquí se ve el antes y el después, y con un
 * clic se aplica; queda en el historial de versiones y se puede deshacer.
 */

const EXAMPLES = [
  ['Hablar de usted', 'Que hable de usted con los clientes en lugar de tú.'],
  ['Pedir el nombre', 'Que al inicio pregunte el nombre del cliente si todavía no lo sabe.'],
  ['Quitar algo', 'Quita todo lo que dice sobre envíos gratis.'],
  ['Agregar un horario', 'Agrega que los domingos cerramos y que en días festivos abrimos de 10 a 2.'],
];

/** Lo aplicado hace poco, por agente: así «Deshacer» sigue a la mano aunque la página se vuelva a dibujar. */
const recent = new Map();

/** Los renglones que cambian, con uno de contexto antes y después; `full` muestra todo el texto. */
function diffList(lines, full) {
  const changed = lines.flatMap((l, i) => (l.state === 'same' ? [] : [i]));
  const near = new Set(changed.flatMap((i) => [i - 1, i, i + 1]));
  const out = [];
  let gap = 0;
  const flushGap = () => { if (gap) out.push(h('li', { class: 'ai-diff-gap small' }, gap === 1 ? '1 renglón sin cambios' : `${gap} renglones sin cambios`)); gap = 0; };
  lines.forEach((l, i) => {
    if (!full && l.state === 'same' && !near.has(i)) { gap++; return; }
    flushGap();
    if (l.state === 'changed') {
      out.push(h('li', { class: 'ai-diff-del' }, h('span', { class: 'sr-only' }, 'Antes: '), l.before));
      out.push(h('li', { class: 'ai-diff-add' }, h('span', { class: 'sr-only' }, 'Después: '), l.text));
    } else if (l.state === 'removed') out.push(h('li', { class: 'ai-diff-del' }, h('span', { class: 'sr-only' }, 'Se quita: '), l.text));
    else if (l.state === 'new') out.push(h('li', { class: 'ai-diff-add' }, h('span', { class: 'sr-only' }, 'Se agrega: '), l.text));
    else out.push(h('li', { class: 'ai-diff-same' }, l.text));
  });
  flushGap();
  // Con scroll propio: se puede enfocar para recorrerlo con el teclado.
  return h('ul', { class: 'ai-diff', tabindex: '0', 'aria-label': 'Cambios en las instrucciones' }, out);
}

/**
 * `getPrompt()`: el texto actual. `apply(prompt)`: lo guarda en el agente (devuelve si se pudo). `context`: lo que la
 * persona está viendo (por ejemplo, un flujo), para que «este flujo» se entienda.
 */
export function promptAssistant({ botId, getPrompt, apply, context = '', label = '¿Qué quieres cambiar en cómo atiende?' }) {
  const taId = `pa-${botId}-${Math.random().toString(36).slice(2, 7)}`;
  let busy = false;
  /** La propuesta en curso: el texto de partida, el resultado y lo que se ha pedido (se pueden encadenar ajustes). */
  let draft = null;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 260)}px`; };
  const ta = h('textarea', { id: taId, rows: 2, maxlength: 2000, placeholder: 'Ejemplo: quita lo de envíos gratis y agrega que los domingos cerramos.', oninput: grow,
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); } } });
  const askBtn = h('button', { type: 'button', class: 'primary ai-go', onclick: () => ask() }, icon('wand', 16), h('span', {}, 'Preparar el cambio'));
  const status = h('p', { class: 'ai-status small', role: 'status', 'aria-live': 'polite' });
  const result = h('div', { class: 'ai-slot' });
  const say = (text, kind = '') => { status.textContent = text; status.className = `ai-status small${kind ? ` ${kind}` : ''}`; };

  function setBusy(on, text = '') {
    busy = on;
    box.setAttribute('aria-busy', String(on));
    askBtn.disabled = on; ta.readOnly = on;
    result.querySelectorAll('button').forEach((b) => { b.disabled = on; });
    say(text, on ? 'busy' : '');
  }

  async function ask() {
    if (busy) return;
    const instruction = ta.value.trim();
    if (!instruction) { say('Escribe qué quieres cambiar.', 'err'); ta.focus(); return; }
    const base = draft ? draft.prompt : getPrompt();
    setBusy(true, 'Leyendo las instrucciones y preparando el cambio…');
    try {
      const r = await api('POST', `/api/chatbots/${botId}/prompt-edit`, { instruction, prompt: base, context: typeof context === 'function' ? context() : context });
      setBusy(false);
      if (!r.changed) { say(r.question || 'No encontré qué cambiar. ¿Puedes decirlo con otras palabras?', 'err'); ta.focus(); return; }
      draft = { original: draft?.original ?? base, prompt: r.prompt, lines: r.lines, summaries: [...(draft?.summaries ?? []), r.summary || instruction] };
      ta.value = ''; grow();
      showProposal();
    } catch (e) {
      setBusy(false);
      say(e.message || 'No se pudo preparar el cambio. Intenta de nuevo.', 'err');
    }
  }

  function showProposal(full = false) {
    const steps = draft.summaries;
    result.replaceChildren(h('div', { class: 'ai-proposal' },
      h('p', { class: 'ai-result-head' }, icon('wand', 16), h('strong', {}, 'Así quedaría')),
      steps.length === 1 ? h('p', { class: 'ai-result-text' }, steps[0]) : h('ol', { class: 'ai-review' }, steps.map((x) => h('li', {}, x))),
      diffList(draft.lines, full),
      h('button', { type: 'button', class: 'fb-link small ai-diff-toggle', onclick: () => showProposal(!full) }, full ? 'Ver solo lo que cambia' : 'Ver todo el texto'),
      h('div', { class: 'row ai-actions' },
        h('button', { type: 'button', class: 'primary', onclick: () => commit() }, 'Aplicar al agente'),
        h('button', { type: 'button', class: 'small', onclick: () => { say('Escribe el siguiente ajuste: se suma a este.'); ta.focus(); } }, 'Pedir otro ajuste'),
        h('button', { type: 'button', class: 'small', onclick: () => { draft = null; result.replaceChildren(); say('Descartado. Las instrucciones siguen igual.'); } }, 'Descartar'))));
    const n = draft.lines.filter((l) => l.state !== 'same').length;
    say(`Revisa el cambio (${n} ${n === 1 ? 'renglón' : 'renglones'}). Aún no se aplica.`);
    if (!full) result.querySelector('.ai-actions')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  async function commit() {
    if (!draft || busy) return;
    const { original, prompt, summaries } = draft;
    setBusy(true, 'Aplicando al agente…');
    let ok = false;
    try { ok = await apply(prompt); } catch (e) { toast(e.message, true); }
    if (ok) recent.set(botId, { summary: summaries.join(' '), previous: original, at: Date.now() });
    if (!box.isConnected) return;
    setBusy(false);
    if (!ok) { say('No se aplicó. Revisa el aviso e intenta de nuevo.', 'err'); return; }
    draft = null;
    showApplied();
  }

  function showApplied() {
    const last = recent.get(botId);
    if (!last || Date.now() - last.at > 30 * 60_000) { recent.delete(botId); return; }
    result.replaceChildren(h('div', { class: 'ai-result' },
      h('p', { class: 'ai-result-head' }, icon('check', 16), h('strong', {}, 'Aplicado: el agente ya atiende así')),
      h('p', { class: 'ai-result-text' }, last.summary),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'small', onclick: () => undo() }, icon('undo', 14), 'Deshacer el cambio'))));
    say('');
  }

  async function undo() {
    const last = recent.get(botId);
    if (!last || busy) return;
    setBusy(true, 'Regresando las instrucciones como estaban…');
    let ok = false;
    try { ok = await apply(last.previous); } catch (e) { toast(e.message, true); }
    if (ok) recent.delete(botId);
    if (!box.isConnected) return;
    setBusy(false);
    if (ok) { result.replaceChildren(); say('Listo: las instrucciones quedaron como estaban.'); }
  }

  const box = h('div', { class: 'ai-compose ai-prompt' },
    h('label', { class: 'ai-label', for: taId }, label),
    ta,
    h('div', { class: 'ai-bar' }, h('span', { class: 'ai-hint small muted' }, 'Di qué quitar, qué agregar o qué cambiar. Antes de aplicarlo ves cómo queda.'), askBtn),
    h('div', { class: 'ai-examples' }, h('span', { class: 'small muted' }, 'Ejemplos:'),
      EXAMPLES.map(([title, idea]) => h('button', { type: 'button', class: 'ai-example', onclick: () => { ta.value = idea; grow(); ta.focus(); say(''); } }, title))),
    status,
    result);
  showApplied();
  return box;
}
