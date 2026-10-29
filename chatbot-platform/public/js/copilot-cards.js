// Copiloto: lo que se pinta en su panel. El texto del modelo se arma como nodos (nunca HTML) y los enlaces solo van a
// rutas conocidas del panel.
import { h } from './core.js';
import { icon } from './icons.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTES = new Set(['contact', 'conversation', 'bot', 'automation', 'pipeline', 'cotizaciones', 'agenda', 'cobros', 'contacts', 'conversations', 'consumo', 'plan', 'users', 'integraciones', 'agentes', 'ajustes', 'estadisticas', 'negocio', 'datos-clientes']);

/** Solo rutas del panel con ids o palabras simples (el servidor ya las filtra; aquí se vuelve a revisar). */
export function safeHref(href) {
  if (typeof href !== 'string' || !href.startsWith('#/') || href.length > 200) return false;
  const [path, query = ''] = href.slice(2).split('?');
  const parts = path.split('/');
  return ROUTES.has(parts[0]) && parts.every((p) => /^[a-z0-9-]{0,60}$/i.test(p) || UUID.test(p)) && /^([a-z_]+=[0-9a-z-]{1,60}(&[a-z_]+=[0-9a-z-]{1,60})*)?$/i.test(query);
}

/** **negritas** y `código` dentro de un renglón. */
function inline(line) {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((part) => {
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', {}, part.slice(2, -2));
    if (part.startsWith('`') && part.endsWith('`')) return h('code', {}, part.slice(1, -1));
    return document.createTextNode(part);
  });
}

/** Párrafos y listas sencillas a partir del texto del Copiloto. */
export function renderText(text) {
  const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return h('ul', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*[-*•]\s+/, '')))));
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return h('ol', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*\d+[.)]\s+/, '')))));
    return h('p', {}, lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l))));
  });
}

const STATUS = {
  done: ['Hecho', 'green'], proposed: ['Por confirmar', 'orange'], declined: ['Descartado', ''], expired: ['Caducó', ''],
  undone: ['Deshecho', ''], failed: ['No se pudo', 'red'], executing: ['En curso', 'accent'], undoing: ['Deshaciendo', 'accent'], unknown: ['Revisar', 'red'],
};

const timeOf = (d) => new Date(d).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });

/** Antes y después por renglón (instrucciones del agente): lo que cambia con un renglón de contexto, plegado. */
function diffBlock(diff) {
  const near = new Set(diff.flatMap((l, i) => (l.state === 'same' ? [] : [i - 1, i, i + 1])));
  const items = [];
  let gap = 0;
  const flush = () => { if (gap) items.push(h('li', { class: 'ai-diff-gap small' }, gap === 1 ? '1 renglón sin cambios' : `${gap} renglones sin cambios`)); gap = 0; };
  diff.forEach((l, i) => {
    if (l.state === 'same' && !near.has(i)) { gap++; return; }
    flush();
    if (l.state === 'removed') items.push(h('li', { class: 'ai-diff-del' }, h('span', { class: 'sr-only' }, 'Se quita: '), l.text));
    else if (l.state === 'new') items.push(h('li', { class: 'ai-diff-add' }, h('span', { class: 'sr-only' }, 'Se agrega: '), l.text));
    else items.push(h('li', { class: 'ai-diff-same' }, l.text));
  });
  flush();
  return h('details', { class: 'cp-diff' }, h('summary', {}, 'Ver los cambios'), h('ul', { class: 'ai-diff', tabindex: '0', 'aria-label': 'Cambios por renglón' }, items));
}

/**
 * Tarjeta de una acción: qué hizo (o qué propone), y sus botones. `on` trae confirm, decline, undo, change (agrega la
 * referencia «Cambiar esto») y visit (al abrir un enlace).
 */
export function actionCard(a, on, busy = false) {
  const [label, tone] = STATUS[a.status] || [a.status, ''];
  const p = a.preview || {};
  const proposed = a.status === 'proposed';
  const buttons = [];
  if (proposed) {
    buttons.push(h('button', { type: 'button', class: 'primary small', disabled: busy, 'data-key': `confirm:${a.id}`, 'aria-label': `Confirmar: ${a.title}`, onclick: () => on.confirm(a) }, 'Confirmar'));
    buttons.push(h('button', { type: 'button', class: 'small', disabled: busy, 'data-key': `decline:${a.id}`, 'aria-label': `Descartar: ${a.title}`, onclick: () => on.decline(a) }, 'Descartar'));
  }
  for (const l of (a.links || []).filter((x) => safeHref(x.href))) {
    buttons.push(h('a', { class: 'btn small', href: l.href, 'data-key': `link:${a.id}:${l.href}`, onclick: () => on.visit(a, l.href) }, l.label));
  }
  if (a.can_undo) buttons.push(h('button', { type: 'button', class: 'small', disabled: busy, 'data-key': `undo:${a.id}`, 'aria-label': `Deshacer: ${a.title}`, onclick: () => on.undo(a) }, icon('undo', 14), a.undo_label || 'Deshacer'));
  if (a.status !== 'executing' && a.status !== 'undoing') buttons.push(h('button', { type: 'button', class: 'small link-button', 'data-key': `change:${a.id}`, 'aria-label': `Cambiar esto: ${a.title}`, onclick: () => on.change(a) }, 'Cambiar esto'));
  return h('article', { class: `cp-card is-${a.status}`, 'data-key': `a:${a.id}`, 'aria-label': `${label}: ${a.title}` },
    h('div', { class: 'cp-card-head' }, h('span', { class: `badge ${tone}` }, label), h('p', { class: 'cp-card-title' }, a.title || 'Acción')),
    proposed && p.lines?.length ? h('ul', { class: 'cp-lines' }, p.lines.map((l) => h('li', {}, l))) : null,
    proposed && p.quote ? h('blockquote', { class: 'cp-quote' }, p.quote) : null,
    Array.isArray(p.diff) && p.diff.length ? diffBlock(p.diff) : null,
    proposed && p.warning ? h('p', { class: 'cp-warning' }, p.warning) : null,
    proposed && a.reasons?.length ? a.reasons.map((r) => h('p', { class: 'cp-reason' }, r)) : null,
    a.error && (a.status === 'failed' || a.status === 'unknown') ? h('p', { class: 'cp-error' }, a.error) : null,
    proposed && a.expires_at ? h('p', { class: 'help' }, `Caduca a las ${timeOf(a.expires_at)}.`) : null,
    buttons.length ? h('div', { class: 'cp-card-actions' }, buttons) : null);
}

/** Las consultas de un tramo, juntas y plegadas: «Consultó 3 cosas». */
export function readsGroup(reads) {
  const n = reads.length;
  return h('details', { class: 'cp-reads', 'data-key': `r:${reads[0].id}` },
    h('summary', {}, `Consultó ${n} ${n === 1 ? 'cosa' : 'cosas'}`),
    h('ul', {}, reads.map((r) => h('li', {}, r.title))));
}
