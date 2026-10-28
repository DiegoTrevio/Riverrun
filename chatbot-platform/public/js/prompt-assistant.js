import { api, h, toast } from './core.js';
import { icon } from './icons.js';

/*
 * Cambiar las instrucciones del agente escribiendo qué se quiere: «quita lo de envíos gratis y agrega que los domingos
 * cerramos». La IA cambia solo esos renglones (lo demás queda igual) y el cambio se aplica al momento: aquí se ve qué se
 * quitó y qué se agregó, y se puede deshacer. Cada cambio queda en el historial de versiones con lo que se pidió, y la IA
 * lo lee en los siguientes para volver a lo ya escrito (cambiarlo, quitarlo o ponerlo de nuevo).
 */

const EXAMPLES = [
  ['Hablar de usted', 'Que hable de usted con los clientes en lugar de tú.'],
  ['Pedir el nombre', 'Que al inicio pregunte el nombre del cliente si todavía no lo sabe.'],
  ['Quitar algo', 'Quita todo lo que dice sobre envíos gratis.'],
  ['Cambiar el horario', 'Cambia el horario: ahora abrimos de 10 a 7 y los domingos cerramos.'],
  ['Volver a algo de antes', 'Vuelve a poner lo que quité la última vez.'],
];

/** Cuánto tiempo sigue a la mano «Deshacer» después de un cambio. */
const KEEP_MS = 30 * 60_000;
/**
 * Lo aplicado hace poco, por agente: `done` (el último al final) y `note`, el aviso que se muestra al volver a dibujar la
 * página (la pestaña del agente se redibuja después de guardar).
 */
const recent = new Map();

/** ¿Es el mismo texto? (el navegador y el servidor pueden diferir en saltos \r o espacios al final). */
const sameText = (a, b) => a !== null && b !== null && String(a).replace(/\r/g, '').trim() === String(b).replace(/\r/g, '').trim();

/** Los renglones que cambiaron, con uno de contexto antes y después; `full` muestra todo el texto. */
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
      out.push(h('li', { class: 'ai-diff-add' }, h('span', { class: 'sr-only' }, 'Ahora: '), l.text));
    } else if (l.state === 'removed') out.push(h('li', { class: 'ai-diff-del' }, h('span', { class: 'sr-only' }, 'Se quitó: '), l.text));
    else if (l.state === 'new') out.push(h('li', { class: 'ai-diff-add' }, h('span', { class: 'sr-only' }, 'Se agregó: '), l.text));
    else out.push(h('li', { class: 'ai-diff-same' }, l.text));
  });
  flushGap();
  // Con scroll propio: se puede enfocar para recorrerlo con el teclado.
  return h('ul', { class: 'ai-diff', tabindex: '0', 'aria-label': 'Cambios en las instrucciones' }, out);
}

/**
 * `getPrompt()`: el texto actual. `apply(prompt, change)`: lo guarda en el agente (devuelve si se pudo); `change` dice en
 * palabras qué se cambió, para el historial. `context`: lo que la persona está viendo (por ejemplo, un flujo), para que
 * «este flujo» se entienda.
 */
export function promptAssistant({ botId, getPrompt, apply, context = '', label = '¿Qué quieres cambiar en cómo atiende?' }) {
  const taId = `pa-${botId}-${Math.random().toString(36).slice(2, 7)}`;
  let busy = false;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 260)}px`; };
  const ta = h('textarea', { id: taId, rows: 2, maxlength: 2000, placeholder: 'Ejemplo: quita lo de envíos gratis y agrega que los domingos cerramos.', oninput: grow,
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); } } });
  const askBtn = h('button', { type: 'button', class: 'primary ai-go', onclick: () => ask() }, icon('wand', 16), h('span', {}, 'Hacer el cambio'));
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

  /** Los cambios que todavía se pueden deshacer (los de hace más de 30 minutos ya no). */
  function done() {
    const entry = recent.get(botId) ?? { done: [] };
    entry.done = entry.done.filter((x) => Date.now() - x.at < KEEP_MS);
    recent.set(botId, entry);
    return entry;
  }

  async function ask() {
    if (busy) return;
    const instruction = ta.value.trim();
    if (!instruction) { say('Escribe qué quieres cambiar.', 'err'); ta.focus(); return; }
    const base = getPrompt();
    if (base === null) { say('Espera a que carguen las instrucciones del agente.', 'err'); return; }
    setBusy(true, 'Leyendo las instrucciones y haciendo el cambio…');
    let r;
    try {
      r = await api('POST', `/api/chatbots/${botId}/prompt-edit`, { instruction, prompt: base, context: typeof context === 'function' ? context() : context });
    } catch (e) {
      setBusy(false);
      say(e.message || 'No se pudo hacer el cambio. Intenta de nuevo.', 'err');
      return;
    }
    if (!r.changed) { setBusy(false); say(r.question || 'No encontré qué cambiar. ¿Puedes decirlo con otras palabras?', 'err'); ta.focus(); return; }
    // Mientras la IA trabajaba se editaron las instrucciones (a mano o en otra pestaña): no se aplica encima.
    if (!sameText(getPrompt(), base)) { setBusy(false); say('Las instrucciones cambiaron mientras se hacía el cambio. Pídelo otra vez para no perder lo nuevo.', 'err'); return; }
    say('Aplicando al agente…', 'busy');
    const summary = r.summary || instruction;
    // Se anota antes de guardar: al guardar, la pestaña del agente se vuelve a dibujar y la caja nueva lo muestra.
    const entry = done();
    const change = { summary, previous: base, applied: r.prompt, lines: r.lines, at: Date.now() };
    entry.done = [...entry.done, change].slice(-10);
    // Solo para lectores de pantalla: a la vista ya está la tarjeta «Listo».
    entry.note = { text: 'Listo: el cambio ya está aplicado. Puedes deshacerlo.', at: Date.now(), quiet: true };
    let ok = false;
    try { ok = await apply(r.prompt, summary); } catch (e) { toast(e.message, true); }
    if (!ok) { entry.done = entry.done.filter((x) => x !== change); entry.note = null; }
    if (!box.isConnected) return;
    setBusy(false);
    if (!ok) { say('No se aplicó. Revisa el aviso e intenta de nuevo.', 'err'); return; }
    ta.value = ''; grow();
    showDone();
  }

  function showDone(full = false) {
    const entry = done();
    const last = entry.done.at(-1);
    const note = entry.note && Date.now() - entry.note.at < 15_000 ? entry.note : null;
    if (!last) { result.replaceChildren(); say(note?.text ?? ''); return; }
    const more = entry.done.length - 1;
    result.replaceChildren(h('div', { class: 'ai-result' },
      h('p', { class: 'ai-result-head' }, icon('check', 16), h('strong', {}, 'Listo: el agente ya atiende así')),
      h('p', { class: 'ai-result-text' }, last.summary),
      diffList(last.lines, full),
      h('button', { type: 'button', class: 'fb-link small ai-diff-toggle', onclick: () => showDone(!full) }, full ? 'Ver solo lo que cambió' : 'Ver todo el texto'),
      h('div', { class: 'row ai-actions' },
        h('button', { type: 'button', class: 'small', onclick: () => undo() }, icon('undo', 14), 'Deshacer este cambio'),
        more ? h('span', { class: 'small muted' }, more === 1 ? 'Después puedes deshacer 1 cambio anterior.' : `Después puedes deshacer ${more} cambios anteriores, uno por uno.`) : null)));
    say(note?.text ?? '');
    if (note?.quiet) status.classList.add('sr-only');
  }

  async function undo() {
    const entry = done();
    const last = entry.done.at(-1);
    if (!last || busy) return;
    if (!sameText(getPrompt(), last.applied)) {
      recent.delete(botId);
      result.replaceChildren();
      say('Las instrucciones cambiaron después de este cambio, así que deshacerlo borraría lo nuevo. Si lo necesitas, vuelve a una versión en el historial del agente.', 'err');
      return;
    }
    setBusy(true, 'Deshaciendo el cambio…');
    entry.done = entry.done.slice(0, -1);
    entry.note = { text: `Listo: deshice «${last.summary}». Las instrucciones quedaron como estaban antes de ese cambio.`, at: Date.now() };
    let ok = false;
    try { ok = await apply(last.previous, `deshice «${last.summary}»`); } catch (e) { toast(e.message, true); }
    if (!ok) { entry.done = [...entry.done, last]; entry.note = null; }
    if (!box.isConnected) return;
    setBusy(false);
    if (!ok) { say('No se pudo deshacer. Revisa el aviso e intenta de nuevo.', 'err'); return; }
    showDone();
  }

  const box = h('div', { class: 'ai-compose ai-prompt' },
    h('label', { class: 'ai-label', for: taId }, label),
    ta,
    h('div', { class: 'ai-bar' }, h('span', { class: 'ai-hint small muted' }, 'Di qué quitar, qué agregar o qué cambiar, aunque ya esté escrito o lo hayas cambiado antes. Se aplica al momento y lo puedes deshacer.'), askBtn),
    h('div', { class: 'ai-examples' }, h('span', { class: 'small muted' }, 'Ejemplos:'),
      EXAMPLES.map(([title, idea]) => h('button', { type: 'button', class: 'ai-example', onclick: () => { ta.value = idea; grow(); ta.focus(); say(''); } }, title))),
    status,
    result);
  showDone();
  return box;
}
