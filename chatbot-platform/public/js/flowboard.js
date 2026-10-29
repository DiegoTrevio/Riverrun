import { needAccount } from './admin.js';
import { triggerSummary } from './automation.js';
import { agentPanel } from './flowboard-agent.js';
import { aiResult, ideaComposer, requestDesign } from './flowboard-ai.js';
import { previewPanel } from './flowboard-preview.js';
import { boardThumb, newId, TEMPLATES } from './flowboard-templates.js';
import { ago, api, area, confirmAction, dialog, field, fill, fmtDate, h, lines, select, state, text, toast } from './core.js';
import { icon } from './icons.js';
import { isSuper, withAcct } from './session.js';
import { varsField } from './vars-help.js';

/*
 * Lienzo de flujos (como una pizarra de Miro): se dibujan el inicio, los mensajes con foto y botones, las esperas y las
 * acciones, se unen con líneas y, al publicar, el servidor los convierte en la regla y los flujos que ya ejecuta el
 * sistema. Notas, textos y fotos sueltas sirven para planear y no se publican.
 */

const NODE_W = 288;
const GAP = 56;
const SNAP = 8;
const FLOW = new Set(['trigger', 'message', 'wait', 'action']);
const BOARD_ONLY = new Set(['note', 'text', 'image']);

const KINDS = {
  trigger: { label: 'Inicio', icon: 'zap' },
  message: { label: 'Mensaje', icon: 'chat' },
  wait: { label: 'Espera', icon: 'clock' },
  action: { label: 'Acción', icon: 'tag' },
  note: { label: 'Nota', icon: 'note' },
  text: { label: 'Texto', icon: 'type' },
  image: { label: 'Foto', icon: 'image' },
};
const ACTIONS = {
  tag: { label: 'Poner una etiqueta', icon: 'tag' },
  handoff: { label: 'Pasar con una persona', icon: 'user' },
  alert: { label: 'Avisar al equipo', icon: 'bell' },
  flow: { label: 'Empezar otro flujo', icon: 'branch' },
  end: { label: 'Terminar el flujo', icon: 'flag' },
};
const STARTS = [
  ['manual', 'Lo inicio yo (desde una conversación o una campaña)'],
  ['message_received', 'El cliente escribe una palabra'],
  ['new_contact', 'Un cliente nuevo escribe por primera vez'],
  ['intent', 'La IA detecta una intención'],
  ['tag_added', 'Se le pone una etiqueta'],
  ['no_reply', 'El cliente deja de responder'],
  ['appointment_booked', 'Agenda una cita'],
  ['goal_completed', 'Se cumple el objetivo de la conversación'],
  ['data_captured', 'Se guarda un dato del cliente'],
  ['handoff', 'La conversación pasa a una persona'],
];
const UNITS = [['minutes', 'minutos'], ['hours', 'horas'], ['days', 'días']];
const UNIT_WORD = { minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'] };
const NOTE_COLORS = [['sun', 'Amarillo'], ['leaf', 'Verde'], ['sky', 'Azul'], ['rose', 'Rosa'], ['sand', 'Arena']];

const DEFAULTS = {
  trigger: () => ({ trigger: { type: 'message_received', match: 'keywords', keywords: [], first_message_only: false }, conditions: [], chatbot_id: null, stop_ai: true, once_per_conversation: false }),
  message: () => ({ text: '', image_id: '', attachment_id: '', photo_hint: '', buttons: [], wait_for_choice: false, if_no_choice: 'end' }),
  wait: () => ({ value: 1, unit: 'days', at_time: '' }),
  action: (kind = 'tag') => ({ action: kind, tag: '', message: '', reason: '', sequence_id: '' }),
  note: () => ({ text: '', color: 'sun', w: 220, h: 160 }),
  text: () => ({ text: 'Título de esta parte', size: 'title' }),
  image: () => ({ attachment_id: '', caption: '', w: 280 }),
};
const SPECS = {
  message: () => ({ type: 'message', data: DEFAULTS.message() }),
  wait: () => ({ type: 'wait', data: DEFAULTS.wait() }),
  tag: () => ({ type: 'action', data: DEFAULTS.action('tag') }),
  handoff: () => ({ type: 'action', data: DEFAULTS.action('handoff') }),
  alert: () => ({ type: 'action', data: DEFAULTS.action('alert') }),
  flow: () => ({ type: 'action', data: DEFAULTS.action('flow') }),
  end: () => ({ type: 'action', data: DEFAULTS.action('end') }),
  note: () => ({ type: 'note', data: DEFAULTS.note() }),
  text: () => ({ type: 'text', data: DEFAULTS.text() }),
  image: () => ({ type: 'image', data: DEFAULTS.image() }),
};
const TONE = { message: 'message', wait: 'wait', note: 'note', text: 'board', image: 'board' };
const toneOf = (key) => TONE[key] ?? 'action';

const defaultTrigger = (type) => ({
  message_received: { type, match: 'keywords', keywords: [], first_message_only: false },
  intent: { type, intent: '', description: '' },
  tag_added: { type, tag: '' },
  no_reply: { type, minutes: 120 },
  appointment_booked: { type, service_id: '' },
  data_captured: { type, field: '' },
}[type] ?? { type });

const waitWords = (d) => `${d.value} ${UNIT_WORD[d.unit][d.value === 1 ? 0 : 1]}`;
const clip = (s, n) => { const one = String(s || '').replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one; };
const isPhone = () => matchMedia('(max-width: 760px)').matches;
const isNarrow = () => matchMedia('(max-width: 1100px)').matches;

/** Cuándo empieza, en palabras (en el lienzo las palabras clave van aparte, como fichas). */
function startLabel(t) {
  if (!t) return 'Lo inicias tú, desde una conversación o una campaña';
  if (t.type === 'message_received') return t.match === 'any' ? 'Cuando escribe cualquier mensaje' : t.match === 'exact' ? 'Cuando escribe exactamente' : 'Cuando su mensaje dice';
  if (t.type === 'tag_added') return t.tag ? `Cuando se le pone la etiqueta «${t.tag}»` : 'Cuando se le pone una etiqueta';
  if (t.type === 'intent') return t.intent ? `Cuando la IA detecta «${t.intent}»` : 'Cuando la IA detecta una intención';
  return STARTS.find(([k]) => k === t.type)?.[1] ?? triggerSummary(t);
}

/** Estado del lienzo para la lista y el encabezado: borrador, publicado, cambios sin publicar o en pausa. */
export function boardStatus(b) {
  if (b.published_revision === null || b.published_revision === undefined) return ['', 'Borrador'];
  if (b.paused) return ['', 'En pausa'];
  return b.pending ? ['orange', 'Cambios sin publicar'] : ['green', 'Publicado'];
}

/* ============================== Lista de lienzos ============================== */

const CREATE_EXAMPLES = [
  ['Bienvenida con menú', 'Cuando un cliente escriba por primera vez, salúdalo por su nombre y ofrécele tres botones: Ver servicios, Agendar una cita y Hablar con alguien (que lo pase con una persona).'],
  ['Promoción', 'Cuando alguien escriba PROMO, mándale la promoción de esta semana con dos botones: Apartar (que lo pase con una persona) y Ver precios. Si no contesta, al día siguiente a las 10 recuérdale que termina el domingo.'],
  ['Seguimiento', 'Lo inicio yo: un mensaje para preguntar si pudo revisar la cotización; si no contesta, otro a los 2 días y uno último a los 5 días ofreciéndole ayuda.'],
  ['Encuesta después de la cita', 'Cuando se agende una cita, al día siguiente pregúntale cómo le fue con botones Excelente, Bien y Mal. Si elige Mal, pásalo con una persona; si elige Excelente, pídele una reseña.'],
];
const AI_STEPS = ['Leyendo tu idea…', 'Escribiendo los mensajes…', 'Uniendo botones y esperas…', 'Revisando que funcione…', 'Ya casi…'];
const EDIT_EXAMPLES = [
  ['Agregar un botón', 'Agrega al primer mensaje un botón «Ubicación» que mande la dirección del negocio.'],
  ['Cambiar una espera', 'Cambia la espera para que el siguiente mensaje salga 2 días después a las 10 de la mañana.'],
  ['Hablar de usted', 'Cambia todos los mensajes para que hablen de usted.'],
  ['Más corto', 'Haz todos los mensajes más cortos y directos, sin perder la información.'],
];

export async function viewFlowBoards(root) {
  if (needAccount(root)) return;
  const boards = await api('GET', withAcct('/api/flow-boards'));
  const create = async (name, board) => {
    try {
      const r = await api('POST', '/api/flow-boards', { name, board, account_id: state.accountId || undefined });
      location.hash = `#/automation/lienzo/${r.id}?ordenar=1`;
    } catch (e) { toast(e.message, true); }
  };
  const blank = () => ({
    nodes: [{ id: 't1', type: 'trigger', x: 0, y: 0, data: DEFAULTS.trigger() }, { id: 'm1', type: 'message', x: 0, y: 220, data: { ...DEFAULTS.message(), text: 'Hola {{nombre}}, ' } }],
    edges: [{ id: 'e1', from: 't1', port: 'out', to: 'm1' }],
  });
  const templates = h('div', { class: 'fb-templates', role: 'list', 'aria-label': 'Empezar un flujo' },
    h('div', { role: 'listitem' }, h('button', { class: 'fb-template blank', type: 'button', onclick: () => create('Flujo nuevo', blank()) },
      h('span', { class: 'fb-template-art' }, icon('plus', 22)),
      h('strong', {}, 'Lienzo en blanco'),
      h('span', { class: 'small muted' }, 'Un inicio y un primer mensaje, listos para dibujar.'))),
    TEMPLATES.map((t) => h('div', { role: 'listitem' }, h('button', { class: 'fb-template', type: 'button', onclick: () => { const b = t.build(); delete b.layout; create(t.name, b); } },
      h('span', { class: 'fb-template-art' }, boardThumb(t.build(), 168, 76)),
      h('strong', {}, t.name),
      h('span', { class: 'small muted' }, t.description)))));

  const row = (b) => {
    const [tone, label] = boardStatus(b);
    const trig = b.summary ? (b.summary.trigger ? triggerSummary(b.summary.trigger) : 'Lo inicias tú') : '—';
    const live = b.published_revision !== null && b.published_revision !== undefined;
    return h('tr', { class: 'click', onclick: () => (location.hash = `#/automation/lienzo/${b.id}`) },
      h('td', {}, h('div', { class: 'fb-row-name' },
        h('span', { class: 'fb-row-thumb' }, boardThumb(b.thumb ?? { nodes: [], edges: [] }, 64, 44)),
        h('span', { class: 'fb-row-text' }, h('a', { href: `#/automation/lienzo/${b.id}` }, h('strong', {}, b.name)), h('span', { class: 'small muted fb-row-sub' }, trig)))),
      h('td', {}, h('span', { class: `badge ${tone}` }, label)),
      h('td', { class: 'num' }, b.summary?.messages ?? '—'),
      h('td', { class: 'num' }, live ? b.people.active : '—'),
      h('td', { class: 'num' }, live ? b.runs : '—'),
      h('td', { class: 'num small muted' }, h('time', { datetime: b.updated_at, title: fmtDate(b.updated_at) }, ago(b.updated_at))));
  };

  const composer = ideaComposer({
    id: 'fb-idea',
    label: 'Describe tu flujo',
    placeholder: 'Ejemplo: cuando alguien escriba PROMO, mándale la promoción con dos botones, Apartar y Ver precios; si no contesta, recuérdale al día siguiente.',
    examples: CREATE_EXAMPLES,
    submit: 'Crear flujo',
    steps: AI_STEPS,
    onSubmit: async ({ idea, file }) => {
      const r = await requestDesign({ url: withAcct('/api/flow-boards/ai'), idea, file });
      // Si ya se fue de esta página, no se crea ni se le lleva al flujo.
      if (!root.isConnected) return;
      const b = await api('POST', '/api/flow-boards', { name: r.name, board: r.board, account_id: state.accountId || undefined });
      try { sessionStorage.setItem(`fb-ai:${b.id}`, JSON.stringify({ summary: r.summary, review: r.review })); } catch { /* sin almacenamiento */ }
      location.hash = `#/automation/lienzo/${b.id}?ordenar=1&ia=1`;
    },
  });

  root.append(
    h('section', { class: 'card fb-start', 'aria-labelledby': 'fb-start-title' },
      h('h2', { id: 'fb-start-title' }, 'Crea un flujo de mensajes'),
      h('p', { class: 'help fb-start-lead' }, 'Cuéntalo como a alguien de tu equipo, o sube una foto de tu dibujo o una captura. Lo armo completo y lo revisas en el lienzo antes de publicarlo.'),
      composer.el,
      h('h3', { class: 'fb-start-sub' }, 'O empieza con una plantilla'),
      templates),
    h('section', { class: 'card', 'aria-labelledby': 'fb-list-title' },
      h('div', { class: 'row between fb-list-head' }, h('h2', { id: 'fb-list-title' }, 'Tus flujos dibujados'), h('span', { class: 'small muted' }, boards.length === 1 ? '1 flujo' : `${boards.length} flujos`)),
      boards.length
        ? h('div', { class: 'table-scroll' }, h('table', { class: 'fb-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Flujo'), h('th', {}, 'Estado'), h('th', { class: 'num' }, 'Mensajes'), h('th', { class: 'num' }, 'En curso'), h('th', { class: 'num' }, 'Veces iniciado'), h('th', { class: 'num' }, 'Actualizado'))),
            h('tbody', {}, boards.map(row))))
        : h('p', { class: 'fb-empty' }, 'Aún no dibujas ningún flujo. Empieza en blanco o con una de las plantillas de arriba.')),
  );
}

/* ============================== Editor ============================== */

const SVGNS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  return el;
};

/** Texto de un mensaje con las variables ({{nombre}}) resaltadas, sin HTML. */
function richText(str) {
  const out = [];
  let last = 0;
  for (const m of String(str).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    if (m.index > last) out.push(str.slice(last, m.index));
    out.push(h('span', { class: 'fb-var' }, `{{${m[1]}}}`));
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push(str.slice(last));
  return out;
}

/** Aviso con un solo botón (el de core.js siempre ofrece «Cancelar»): se cierra con Listo o Escape. */
function notice(title, content) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const titleId = `fb-notice-${Date.now()}`;
    const box = h('dialog', { class: 'card app-dialog', 'aria-labelledby': titleId });
    const close = () => { box.close(); box.remove(); if (previous?.isConnected) previous.focus(); resolve(); };
    box.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    box.append(h('h2', { id: titleId }, title), content, h('div', { class: 'row dialog-actions' }, h('button', { class: 'primary', type: 'button', onclick: close }, 'Listo')));
    document.body.append(box);
    box.showModal();
    box.querySelector('.dialog-actions button').focus();
  });
}

/** Fotos de la biblioteca: se descargan una vez y se muestran con su tipo real (el servidor las entrega como descarga). */
const blobUrls = new Map();
function fileUrl(file) {
  if (!file) return Promise.resolve('');
  if (!blobUrls.has(file.id)) {
    blobUrls.set(file.id, fetch(`/api/attachments/${file.id}/file`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('foto'))))
      .then((b) => URL.createObjectURL(new Blob([b], { type: file.mime })))
      .catch(() => { blobUrls.delete(file.id); return ''; }));
  }
  return blobUrls.get(file.id);
}

/** Ruta de una línea: tramos rectos con esquinas redondeadas, de la salida (abajo o a la derecha) a la entrada (arriba). */
function route(a, b, side) {
  const G = 24;
  const pts = [{ x: a.x, y: a.y }];
  if (side === 'bottom') {
    if (b.y - a.y >= 12) { const my = a.y + Math.max(Math.min(G, (b.y - a.y) / 2), Math.min(GAP / 2 + 4, (b.y - a.y) / 2)); pts.push({ x: a.x, y: my }, { x: b.x, y: my }); }
    else {
      const gx = Math.abs(b.x - a.x) > NODE_W + 40 ? (a.x + b.x) / 2 : Math.max(a.x, b.x) + NODE_W / 2 + 40;
      pts.push({ x: a.x, y: a.y + G }, { x: gx, y: a.y + G }, { x: gx, y: b.y - G }, { x: b.x, y: b.y - G });
    }
  } else if (b.x - a.x >= G && b.y - a.y >= G) pts.push({ x: b.x, y: a.y });
  else {
    // El destino está arriba o a la izquierda: sube por en medio del hueco hasta su entrada.
    const left = b.x - NODE_W / 2;
    const gx = left - a.x >= G * 3 ? a.x + Math.max(G, (left - a.x) / 2) : a.x + G;
    pts.push({ x: gx, y: a.y }, { x: gx, y: b.y - G }, { x: b.x, y: b.y - G });
  }
  pts.push({ x: b.x, y: b.y });
  const p = pts.filter((q, i) => i === 0 || q.x !== pts[i - 1].x || q.y !== pts[i - 1].y);
  let d = `M${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [u, c, v] = [p[i - 1], p[i], p[i + 1]];
    const r = Math.min(6, Math.hypot(c.x - u.x, c.y - u.y) / 2, Math.hypot(v.x - c.x, v.y - c.y) / 2);
    d += `L${c.x - Math.sign(c.x - u.x) * r} ${c.y - Math.sign(c.y - u.y) * r}Q${c.x} ${c.y} ${c.x + Math.sign(v.x - c.x) * r} ${c.y + Math.sign(v.y - c.y) * r}`;
  }
  d += `L${p.at(-1).x} ${p.at(-1).y}`;
  const k = Math.max(0, Math.floor((p.length - 1) / 2));
  const q = p[Math.min(k + 1, p.length - 1)];
  return { d, mid: { x: (p[k].x + q.x) / 2, y: (p[k].y + q.y) / 2 } };
}

export async function viewFlowBoard(root, id) {
  const row = await api('GET', `/api/flow-boards/${id}`);
  const inAcct = (url) => (isSuper() ? `${url}${url.includes('?') ? '&' : '?'}account_id=${row.account_id}` : url);
  const [bots, sequences, files, services] = await Promise.all([
    api('GET', inAcct('/api/chatbots')).catch(() => []),
    api('GET', inAcct('/api/sequences')).catch(() => []),
    api('GET', inAcct('/api/attachments')).catch(() => []),
    api('GET', inAcct('/api/services')).catch(() => []),
  ]);
  if (!root.isConnected) return;
  const catalog = { loaded: false, images: [] };

  const S = {
    name: row.name, revision: row.revision, published_revision: row.published_revision, published_at: row.published_at, paused: row.paused, pending: row.pending,
    board: { nodes: row.board.nodes, edges: row.board.edges, settings: row.board.settings },
    problems: row.problems ?? [],
    sel: new Set(), edge: null, editing: null,
    dirty: false, conflict: false, saveState: 'saved',
    view: isPhone() ? 'list' : 'canvas', panel: null, boardPanel: false,
  };
  let vp = { x: 0, y: 0, zoom: 1 };
  try { const saved = JSON.parse(localStorage.getItem(`fb-vp:${id}`) || 'null'); if (saved && Number.isFinite(saved.zoom)) vp = saved; } catch { /* sin almacenamiento */ }
  let fitted = vp.zoom !== 1 || vp.x !== 0 || vp.y !== 0;

  const byId = (nid) => S.board.nodes.find((n) => n.id === nid);
  const edgeFrom = (nid, port = 'out') => S.board.edges.find((e) => e.from === nid && e.port === port);
  const problemsFor = (nid) => S.problems.filter((p) => p.node === nid);
  /** Lo que sigue en la misma línea (esperas incluidas, hasta el siguiente mensaje): ahí un botón «sigue ya». */
  const ahead = (nid) => {
    const set = new Set();
    for (let e = edgeFrom(nid), guard = 0; e && guard < 50; e = edgeFrom(e.to), guard++) {
      set.add(e.to);
      if (byId(e.to)?.type !== 'wait') break;
    }
    return set;
  };
  const kindLabel = (n) => (n.type === 'action' ? ACTIONS[n.data.action].label : KINDS[n.type].label);
  const iconOf = (n) => (n.type === 'action' ? ACTIONS[n.data.action].icon : KINDS[n.type].icon);
  const describe = (n) => {
    if (!n) return '';
    if (n.type === 'message') return clip(n.data.text, 40) || (n.data.image_id || n.data.attachment_id ? 'Foto' : 'Mensaje vacío');
    if (n.type === 'wait') return waitWords(n.data);
    if (n.type === 'action') return n.data.action === 'tag' && n.data.tag ? `Etiqueta «${n.data.tag}»` : ACTIONS[n.data.action].label;
    if (n.type === 'trigger') return n.data.trigger ? triggerSummary(n.data.trigger) : 'Lo inicias tú';
    return clip(n.data.text || n.data.caption, 40) || KINDS[n.type].label;
  };
  /** Sin una Espera después, «esperar a que elija» le da un día (así se publica); con Espera, el tiempo es el de ella. */
  const choiceWindow = (n) => { const e = edgeFrom(n.id); const t = e && byId(e.to); return t && t.type !== 'wait' ? ' (hasta 1 día)' : ''; };
  /** A dónde lleva el botón de un mensaje, en palabras cortas para el lienzo. */
  const buttonDest = (n, b) => {
    const e = edgeFrom(n.id, `b:${b.id}`);
    const t = e && byId(e.to);
    if (!t) return 'termina';
    if (ahead(n.id).has(t.id)) return 'sigue';
    if (t.type === 'action') return { tag: 'etiqueta', handoff: 'persona', alert: 'aviso', flow: 'otro flujo', end: 'termina' }[t.data.action];
    return 'rama';
  };
  const validTarget = (n) => !!n && (n.type === 'message' || n.type === 'wait' || n.type === 'action');
  const canChain = (n) => !!n && (n.type === 'trigger' || n.type === 'message' || n.type === 'wait' || (n.type === 'action' && (n.data.action === 'tag' || n.data.action === 'alert')));

  /* ---------- Guardado automático, deshacer y rehacer ---------- */

  const snap = () => JSON.stringify({ nodes: S.board.nodes, edges: S.board.edges, settings: S.board.settings });
  let last = snap();
  const past = [];
  const future = [];
  let coalescing = false;
  let coTimer = 0;
  let saveTimer = 0;
  let chain = Promise.resolve();

  function commit({ coalesce = false, inspector = false } = {}) {
    const now = snap();
    if (now === last) { if (inspector) renderInspector(); return; }
    if (!(coalesce && coalescing)) { past.push(last); if (past.length > 120) past.shift(); future.length = 0; }
    last = now;
    coalescing = coalesce;
    clearTimeout(coTimer);
    if (coalesce) coTimer = setTimeout(() => { coalescing = false; }, 900);
    scheduleSave();
    refresh({ inspector });
  }
  function restore(json) {
    const b = JSON.parse(json);
    S.board.nodes = b.nodes; S.board.edges = b.edges; S.board.settings = b.settings;
    for (const nid of [...S.sel]) if (!byId(nid)) S.sel.delete(nid);
    if (S.edge && !S.board.edges.some((e) => e.id === S.edge)) S.edge = null;
    scheduleSave();
    refresh({ inspector: true });
  }
  const undo = () => { if (!past.length) return; future.push(last); last = past.pop(); coalescing = false; restore(last); };
  const redo = () => { if (!future.length) return; past.push(last); last = future.pop(); coalescing = false; restore(last); };

  function scheduleSave() {
    S.dirty = true;
    setSave('pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), 900);
  }
  function save() {
    chain = chain.then(async () => {
      if (!S.dirty || S.conflict) return;
      S.dirty = false;
      setSave('saving');
      try {
        const r = await api('PUT', `/api/flow-boards/${id}`, { revision: S.revision, name: S.name, board: { ...S.board, viewport: { x: 0, y: 0, zoom: 1 } } });
        S.revision = r.revision; S.published_revision = r.published_revision; S.problems = r.problems; S.pending = r.pending;
        setSave(S.dirty ? 'pending' : 'saved');
        refreshProblems();
      } catch (e) {
        if (e.status === 409) { S.conflict = true; setSave('conflict'); }
        else {
          if (S.saveState !== 'error') toast(`No se guardó el lienzo: ${e.message}`, true);
          S.dirty = true; setSave('error', e.message);
        }
      }
    });
    return chain;
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (S.dirty) save();
    await chain;
  }

  /* ---------- Armazón ---------- */

  const saveEl = h('span', { class: 'fb-save small', role: 'status' });
  const statusEl = h('span', { class: 'badge' });
  const titleBtn = h('button', { class: 'fb-title-btn', type: 'button', title: 'Cambiar el nombre', onclick: () => rename() }, S.name);
  const countEl = h('span', { class: 'fb-count' });
  const problemsBtn = h('button', { class: 'fb-tool fb-problems-btn', type: 'button', onclick: () => openPanel('problems') }, icon('alert', 16), h('span', { class: 'fb-tool-label' }, 'Pendientes'), countEl);
  const undoBtn = h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Deshacer', title: 'Deshacer (Ctrl+Z)', onclick: () => undo() }, icon('undo', 18));
  const redoBtn = h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Rehacer', title: 'Rehacer (Ctrl+Mayús+Z)', onclick: () => redo() }, icon('redo', 18));
  const publishBtn = h('button', { class: 'primary fb-publish', type: 'button', onclick: () => publish() }, 'Publicar');
  const menuBtn = h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Más opciones', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => { e.stopPropagation(); openMenu(menuBtn); } }, icon('more', 18));
  const aiBtn = h('button', { class: 'fb-tool fb-ai-btn', type: 'button', 'aria-label': 'Cambiar con IA', title: 'Escribe qué cambiar y la IA lo hace en el lienzo', onclick: () => openPanel('ai') }, icon('wand', 16), h('span', { class: 'fb-tool-label' }, 'Cambiar con IA'));
  const top = h('header', { class: 'fb-top' },
    h('a', { class: 'fb-icon', href: '#/automation/lienzo', 'aria-label': 'Volver a tus flujos', title: 'Volver a tus flujos' }, icon('arrow-left', 18)),
    h('div', { class: 'fb-title-wrap' }, h('h1', { class: 'fb-title' }, titleBtn), statusEl, saveEl),
    h('div', { class: 'fb-top-tools' },
      h('div', { class: 'fb-tool-group fb-wide' }, undoBtn, redoBtn),
      h('span', { class: 'fb-divider fb-wide', 'aria-hidden': 'true' }),
      h('div', { class: 'fb-tool-group fb-wide' },
        problemsBtn,
        h('button', { class: 'fb-tool', type: 'button', onclick: () => openPanel('preview') }, icon('play', 16), h('span', { class: 'fb-tool-label' }, 'Vista previa')),
        h('button', { class: 'fb-tool', type: 'button', onclick: () => openPanel('agent') }, icon('bot', 16), h('span', { class: 'fb-tool-label' }, 'Instrucciones del agente'))),
      aiBtn,
      menuBtn,
      publishBtn));

  const viewToggle = h('div', { class: 'fb-viewtoggle', role: 'group', 'aria-label': 'Cómo ver el flujo' },
    h('button', { type: 'button', 'data-view': 'list', onclick: () => setView('list') }, icon('list', 16), 'Lista'),
    h('button', { type: 'button', 'data-view': 'canvas', onclick: () => setView('canvas') }, icon('layout', 16), 'Lienzo'));

  const PALETTE = [
    ['Flujo', [
      ['message', 'Mensaje', 'chat', 'Texto, foto o archivo, con botones'],
      ['wait', 'Espera', 'clock', 'Tiempo antes del mensaje siguiente'],
      ['tag', 'Etiqueta', 'tag', 'Le pone una etiqueta al cliente'],
      ['handoff', 'Persona', 'user', 'Pasa la conversación a tu equipo'],
      ['alert', 'Aviso', 'bell', 'Avisa a tu equipo (desde el inicio)'],
      ['flow', 'Otro flujo', 'branch', 'Empieza un flujo que ya tienes'],
      ['end', 'Fin', 'flag', 'Termina el flujo'],
    ]],
    ['Pizarra', [
      ['note', 'Nota', 'note', 'Una idea o un pendiente (no se publica)'],
      ['text', 'Texto', 'type', 'Un título para ordenar el lienzo'],
      ['image', 'Foto', 'image', 'Una foto de referencia (no se envía)'],
    ]],
  ];
  const palette = h('nav', { class: 'fb-palette', 'aria-label': 'Agregar al lienzo' },
    PALETTE.map(([group, items]) => h('div', { class: 'fb-pal-group' },
      h('div', { class: 'fb-pal-title' }, group),
      items.map(([key, label, iconName, hint]) => h('button', {
        class: 'fb-pal-item', type: 'button', title: hint,
        onclick: () => addFromPalette(SPECS[key]),
        onpointerdown: (e) => paletteDrag(e, key, label, iconName),
      }, h('span', { class: `fb-tile t-${toneOf(key)}`, 'aria-hidden': 'true' }, icon(iconName, 16)), h('span', { class: 'fb-pal-label' }, label), h('span', { class: 'fb-pal-grip', 'aria-hidden': 'true' }, icon('grip', 14)))))),
    h('p', { class: 'fb-pal-tip small muted' }, 'Arrastra al lienzo, o toca para agregarlo después de lo que tengas elegido (o al final del flujo).'));

  const markers = s('defs');
  for (const [mid, cls] of [['fb-arrow', 'fb-arrow'], ['fb-arrow-on', 'fb-arrow on']]) {
    const m = s('marker', { id: `${mid}-${id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(s('path', { d: 'M1 1L9 5L1 9z', class: cls }));
    markers.append(m);
  }
  const edgeLayer = s('g');
  const ghost = s('path', { class: 'fb-ghost', d: '' });
  const edgeTools = s('g');
  const edgesSvg = s('svg', { class: 'fb-edges', width: 1, height: 1, 'aria-hidden': 'true' });
  edgesSvg.append(markers, edgeLayer, ghost, edgeTools);
  const backLayer = h('div', { class: 'fb-layer' });
  const nodeLayer = h('div', { class: 'fb-layer' });
  const world = h('div', { class: 'fb-world' }, backLayer, edgesSvg, nodeLayer);
  const zoomLabel = h('button', { class: 'fb-zoom-label', type: 'button', title: 'Ver al 100 %', onclick: () => zoomTo(1) }, '100 %');
  const zoomCtl = h('div', { class: 'fb-zoom', role: 'group', 'aria-label': 'Acercar y alejar' },
    h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Alejar', title: 'Alejar (−)', onclick: () => zoomBy(1 / 1.2) }, icon('minus', 16)),
    zoomLabel,
    h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Acercar', title: 'Acercar (+)', onclick: () => zoomBy(1.2) }, icon('plus', 16)),
    h('span', { class: 'fb-divider', 'aria-hidden': 'true' }),
    h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Ver todo el flujo', title: 'Ver todo (F)', onclick: () => fit() }, icon('fit', 16)),
    h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Ordenar el flujo', title: 'Ordenar el flujo', onclick: () => tidy() }, icon('layout', 16)));
  const miniSvg = s('svg', { class: 'fb-mini-svg', width: 176, height: 112, 'aria-hidden': 'true' });
  const minimap = h('div', { class: 'fb-minimap', title: 'Mapa del flujo: toca para ir a esa parte' }, miniSvg);
  const conflictBar = h('div', { class: 'fb-conflict banner warn', role: 'alert', hidden: true },
    h('strong', {}, 'Este flujo cambió en otra pestaña o en otro equipo. '), 'Tus últimos cambios no se guardaron. ',
    h('button', { type: 'button', class: 'small', onclick: () => location.reload() }, 'Recargar'));
  const marquee = h('div', { class: 'fb-marquee', hidden: true });
  const canvas = h('div', { class: 'fb-canvas', tabindex: '0', role: 'region', 'aria-roledescription': 'lienzo', 'aria-label': 'Lienzo del flujo. Arrastra el fondo para moverte; con Ctrl y la rueda acercas o alejas; Supr borra lo elegido.' },
    world, marquee, zoomCtl, minimap, conflictBar);
  const outline = h('div', { class: 'fb-outline', hidden: true });
  const stage = h('div', { class: 'fb-stage' }, canvas, outline);
  const inspector = h('aside', { class: 'fb-inspector', 'aria-label': 'Propiedades de lo elegido' });
  const panelBody = h('div', { class: 'fb-panel-body' });
  const panelTitle = h('h2', { class: 'fb-panel-title', id: `fb-panel-${id}` });
  const panel = h('aside', { class: 'fb-panel', hidden: true, 'aria-labelledby': `fb-panel-${id}` },
    h('div', { class: 'fb-panel-head' }, panelTitle, h('button', { class: 'fb-icon', type: 'button', 'aria-label': 'Cerrar', onclick: () => closePanel() }, icon('x', 18))),
    panelBody);
  const phoneBar = h('nav', { class: 'fb-phonebar', 'aria-label': 'Agregar al flujo' },
    h('button', { type: 'button', class: 'fb-phone-ai', onclick: () => openPanel('ai') }, icon('wand', 18), h('span', {}, 'Con IA')),
    [['message', 'Mensaje', 'chat'], ['wait', 'Espera', 'clock'], ['tag', 'Etiqueta', 'tag'], ['handoff', 'Persona', 'user'], ['note', 'Nota', 'note']].map(([key, label, iconName]) =>
      h('button', { type: 'button', onclick: () => addFromPalette(SPECS[key]) }, icon(iconName, 18), h('span', {}, label))));
  const editor = h('div', { class: 'fb-editor' }, top, viewToggle, h('div', { class: 'fb-body' }, palette, stage, inspector, panel), phoneBar);
  root.append(editor);

  /* ---------- Vista: lienzo o lista ---------- */

  function setView(v) {
    S.view = v;
    canvas.hidden = v !== 'canvas';
    outline.hidden = v !== 'list';
    editor.classList.toggle('is-list', v === 'list');
    viewToggle.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    if (v === 'canvas') { geo.clear(); renderNodes(); if (!fitted) { fitted = true; fit({ readable: true }); } else applyViewport(); }
    else renderOutline();
  }

  /* ---------- Vista y zoom ---------- */

  const clampZoom = (z) => Math.min(2, Math.max(0.2, z));
  let vpTimer = 0;
  function applyViewport() {
    world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
    zoomLabel.textContent = `${Math.round(vp.zoom * 100)} %`;
    drawMinimap();
    clearTimeout(vpTimer);
    vpTimer = setTimeout(() => { try { localStorage.setItem(`fb-vp:${id}`, JSON.stringify(vp)); } catch { /* sin almacenamiento */ } }, 300);
  }
  function zoomAt(sx, sy, z) {
    const nz = clampZoom(z);
    vp = { x: sx - (sx - vp.x) * (nz / vp.zoom), y: sy - (sy - vp.y) * (nz / vp.zoom), zoom: nz };
    applyViewport();
  }
  const zoomBy = (f) => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, vp.zoom * f); };
  const zoomTo = (z) => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, z); };
  const toWorld = (cx, cy) => { const r = canvas.getBoundingClientRect(); return { x: (cx - r.left - vp.x) / vp.zoom, y: (cy - r.top - vp.y) / vp.zoom }; };
  const sizeOf = (n) => geo.get(n.id) ?? { w: n.type === 'note' || n.type === 'image' ? n.data.w : NODE_W, h: n.type === 'note' ? n.data.h : 120 };
  function bounds(list = S.board.nodes) {
    if (!list.length) return { x: 0, y: 0, w: NODE_W, h: 200 };
    const x = Math.min(...list.map((n) => n.x)), y = Math.min(...list.map((n) => n.y));
    return { x, y, w: Math.max(...list.map((n) => n.x + sizeOf(n).w)) - x, h: Math.max(...list.map((n) => n.y + sizeOf(n).h)) - y };
  }
  /** Todo el flujo a la vista. Al abrir (`readable`), no aleja tanto que no se lea: lo que no cabe se ve en el mapa. */
  function fit({ readable = false } = {}) {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const b = bounds();
    const z = clampZoom(Math.max(readable ? Math.min(0.75, r.width / 900) : 0, Math.min(1, (r.width - 96) / b.w, (r.height - 128) / b.h)));
    vp = { zoom: z, x: b.w * z > r.width - 96 ? 48 - b.x * z : (r.width - b.w * z) / 2 - b.x * z, y: b.h * z > r.height - 128 ? 40 - b.y * z : Math.max(40, (r.height - b.h * z) / 2) - b.y * z };
    applyViewport();
  }
  function centerOn(n) {
    const r = canvas.getBoundingClientRect();
    const g = sizeOf(n);
    vp = { ...vp, x: r.width / 2 - (n.x + g.w / 2) * vp.zoom, y: r.height / 3 - (n.y + g.h / 2) * vp.zoom };
    applyViewport();
  }

  /* ---------- Elementos ---------- */

  const els = new Map();
  const geo = new Map();

  function nodeSig(n) {
    const ports = n.type === 'message' ? n.data.buttons.map((b) => buttonDest(n, b)) : [];
    return JSON.stringify([n.data, S.sel.has(n.id), problemsFor(n.id).map((p) => p.message), ports, !!edgeFrom(n.id)]);
  }
  function renderNodes() {
    const ids = new Set(S.board.nodes.map((n) => n.id));
    for (const [nid, rec] of els) if (!ids.has(nid)) { rec.el.remove(); els.delete(nid); geo.delete(nid); }
    for (const n of S.board.nodes) {
      let rec = els.get(n.id);
      if (!rec) {
        rec = { el: h('div', { class: 'fb-node', 'data-id': n.id, tabindex: '0', role: 'group' }), sig: '' };
        els.set(n.id, rec);
        (BOARD_ONLY.has(n.type) ? backLayer : nodeLayer).append(rec.el);
      }
      const sig = nodeSig(n);
      if (rec.sig !== sig && S.editing !== n.id) { buildNode(rec.el, n); rec.sig = sig; geo.delete(n.id); }
      rec.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    }
    if (!canvas.hidden) measure();
    drawEdges();
    drawMinimap();
  }
  function measure() {
    for (const n of S.board.nodes) {
      if (geo.has(n.id)) continue;
      const el = els.get(n.id)?.el;
      if (!el?.offsetWidth) continue;
      const ports = {};
      for (const p of el.querySelectorAll('[data-port]')) {
        let x = p.offsetWidth / 2, y = p.offsetHeight / 2;
        for (let c = p; c && c !== el; c = c.offsetParent) { x += c.offsetLeft; y += c.offsetTop; }
        ports[p.dataset.port] = { dx: x, dy: y };
      }
      geo.set(n.id, { w: el.offsetWidth, h: el.offsetHeight, ports });
    }
  }

  const head = (n, label, meta) => h('div', { class: 'fb-node-head' },
    h('span', { class: `fb-tile t-${n.type}`, 'aria-hidden': 'true' }, icon(iconOf(n), 16)),
    h('span', { class: 'fb-node-title' }, label),
    meta ? h('span', { class: 'fb-node-meta' }, meta) : null,
    problemsFor(n.id).some((p) => !p.warning) ? h('span', { class: 'fb-node-alert', title: problemsFor(n.id).map((p) => p.message).join('\n') }, icon('alert', 14)) : null);
  const outPort = (n) => h('span', { class: `fb-port out${edgeFrom(n.id) ? ' on' : ''}`, 'data-port': 'out', title: 'Arrastra para unir con lo que sigue' });

  function photoFor(d) {
    if (d.image_id) return h('img', { src: `/api/images/${d.image_id}/file`, alt: '', loading: 'lazy', draggable: 'false' });
    const f = files.find((x) => x.id === d.attachment_id);
    if (!f) return null;
    if (f.kind !== 'image') return h('div', { class: 'fb-file' }, icon('paperclip', 16), h('span', {}, f.name));
    const img = h('img', { alt: '', draggable: 'false' });
    fileUrl(f).then((url) => { if (url) img.src = url; });
    return img;
  }

  function buildNode(el, n) {
    const d = n.data;
    const probs = problemsFor(n.id);
    const errorProb = probs.some((p) => !p.warning);
    el.className = `fb-node t-${n.type}${S.sel.has(n.id) ? ' is-sel' : ''}${errorProb ? ' has-problem' : ''}${probs.some((p) => p.warning) ? ' is-loose' : ''}${n.type === 'note' ? ` c-${d.color}` : ''}`;
    el.style.width = n.type === 'note' || n.type === 'image' ? `${d.w}px` : n.type === 'text' ? '' : `${NODE_W}px`;
    el.style.height = n.type === 'note' ? `${d.h}px` : '';
    el.setAttribute('aria-label', `${kindLabel(n)}: ${describe(n)}${errorProb ? '. Tiene pendientes' : ''}${S.sel.has(n.id) ? '. Elegido' : ''}`);
    const kids = [];
    if (n.type !== 'trigger' && FLOW.has(n.type)) kids.push(h('span', { class: 'fb-port in', 'aria-hidden': 'true' }));
    if (n.type === 'trigger') {
      const t = d.trigger;
      kids.push(head(n, 'Inicio', d.stop_ai && t ? 'el agente no contesta' : null),
        h('div', { class: 'fb-node-body' },
          h('p', { class: 'fb-strong' }, startLabel(t)),
          t?.type === 'message_received' && t.match !== 'any' ? h('div', { class: 'fb-chips' }, t.keywords.length ? t.keywords.slice(0, 8).map((k) => h('span', { class: 'fb-chip' }, k)) : h('span', { class: 'fb-chip empty' }, 'Escribe las palabras')) : null,
          d.chatbot_id ? h('p', { class: 'fb-sub' }, `Solo con ${bots.find((b) => b.id === d.chatbot_id)?.name ?? 'un agente'}`) : null),
        outPort(n));
    } else if (n.type === 'message') {
      const replies = d.buttons.filter((b) => b.kind === 'reply');
      const photo = photoFor(d);
      kids.push(head(n, 'Mensaje', replies.length ? `${replies.length} ${replies.length === 1 ? 'botón' : 'botones'}` : null),
        h('div', { class: 'fb-node-body' },
          photo ? h('div', { class: 'fb-media' }, photo) : null,
          !photo && d.photo_hint ? h('p', { class: 'fb-missing' }, icon('image', 14), h('span', {}, `Falta la foto: ${d.photo_hint}`)) : null,
          d.text.trim() ? h('p', { class: 'fb-msg' }, richText(d.text)) : h('p', { class: 'fb-msg fb-placeholder' }, photo ? 'Solo la foto, sin texto' : 'Escribe el mensaje…'),
          d.buttons.length ? h('div', { class: 'fb-buttons' }, d.buttons.map((b) => {
            if (b.kind === 'url') return h('div', { class: 'fb-btn url' }, icon('external', 14), h('span', { class: 'fb-btn-label' }, b.label || 'Enlace sin texto'));
            const dest = buttonDest(n, b);
            return h('div', { class: 'fb-btn' }, h('span', { class: 'fb-btn-label' }, b.label || 'Botón sin texto'), h('span', { class: `fb-btn-dest d-${dest.replace(' ', '-')}` }, dest),
              h('span', { class: `fb-port opt${edgeFrom(n.id, `b:${b.id}`) ? ' on' : ''}`, 'data-port': `b:${b.id}`, title: `Arrastra para decir qué pasa al tocar «${b.label}»` }));
          })) : null,
          replies.length && d.wait_for_choice ? h('p', { class: 'fb-sub' }, `Espera a que elija${choiceWindow(n)}; ${d.if_no_choice === 'end' ? 'si no elige, termina' : 'si no, sigue'}`) : null),
        outPort(n));
    } else if (n.type === 'wait') {
      kids.push(head(n, 'Espera'), h('div', { class: 'fb-node-body fb-wait' }, h('strong', {}, waitWords(d)), d.at_time ? h('span', { class: 'fb-sub' }, `y a las ${d.at_time}`) : null), outPort(n));
    } else if (n.type === 'action') {
      const detail = d.action === 'tag' ? (d.tag ? `«${d.tag}»` : 'Escribe la etiqueta')
        : d.action === 'flow' ? (sequences.find((q) => q.id === d.sequence_id)?.name ?? 'Elige el flujo')
        : d.action === 'alert' ? clip(d.message, 60) || 'Avisa a tu equipo en el panel'
        : d.action === 'handoff' ? 'El agente deja de contestar' : 'Aquí termina';
      kids.push(head(n, ACTIONS[d.action].label), h('div', { class: 'fb-node-body' }, h('p', { class: 'fb-sub' }, detail)));
      if (d.action === 'tag' || d.action === 'alert') kids.push(outPort(n));
    } else if (n.type === 'note') {
      kids.push(h('div', { class: 'fb-note-text' }, d.text || 'Doble clic para escribir'), h('span', { class: 'fb-resize', 'data-resize': 'note', 'aria-hidden': 'true' }));
    } else if (n.type === 'text') {
      kids.push(h('div', { class: `fb-note-text fb-text-${d.size}` }, d.text || 'Texto'));
    } else if (n.type === 'image') {
      const f = files.find((x) => x.id === d.attachment_id);
      const img = h('img', { alt: d.caption || 'Foto de referencia', draggable: 'false' });
      if (f) fileUrl(f).then((url) => { if (url) img.src = url; });
      kids.push(f ? h('div', { class: 'fb-image' }, img) : h('div', { class: 'fb-image empty' }, icon('image', 22), h('span', { class: 'small' }, 'Elige una foto')),
        d.caption ? h('p', { class: 'fb-caption' }, d.caption) : null,
        h('span', { class: 'fb-resize', 'data-resize': 'image', 'aria-hidden': 'true' }));
    }
    fill(el, ...kids);
  }

  /** Escribir en una nota o un texto directo sobre el lienzo (como en una pizarra). */
  function editInline(n) {
    const el = els.get(n.id)?.el?.querySelector('.fb-note-text');
    if (!el) return;
    S.editing = n.id;
    el.textContent = n.data.text;
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.focus();
    getSelection()?.selectAllChildren(el);
    el.oninput = () => { n.data.text = el.innerText.slice(0, n.type === 'note' ? 2000 : 400); commit({ coalesce: true }); };
    el.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); el.blur(); } };
    el.onblur = () => { el.contentEditable = 'false'; S.editing = null; els.get(n.id).sig = ''; refresh({ inspector: true }); };
  }

  /* ---------- Líneas y mapa ---------- */

  const portPoint = (n, port) => { const p = geo.get(n.id)?.ports[port]; return p ? { x: n.x + p.dx, y: n.y + p.dy } : null; };
  const inPoint = (n) => ({ x: n.x + (geo.get(n.id)?.w ?? NODE_W) / 2, y: n.y - 1 });
  function drawEdges() {
    const kids = [];
    const tools = [];
    for (const e of S.board.edges) {
      const a = byId(e.from), b = byId(e.to);
      const p = a && b && portPoint(a, e.port);
      if (!p) continue;
      const { d, mid } = route(p, inPoint(b), e.port === 'out' ? 'bottom' : 'right');
      const on = S.edge === e.id || S.sel.has(e.from) || S.sel.has(e.to);
      kids.push(s('path', { class: `fb-edge${on ? ' on' : ''}${e.port !== 'out' ? ' opt' : ''}`, d, 'marker-end': `url(#${on ? 'fb-arrow-on' : 'fb-arrow'}-${id})` }), s('path', { class: 'fb-edge-hit', d, 'data-edge': e.id }));
      if (S.edge === e.id) {
        const g = s('g', { class: 'fb-edge-del', 'data-edge-del': e.id, transform: `translate(${mid.x} ${mid.y})` });
        const t = s('title'); t.textContent = 'Quitar esta línea';
        g.append(s('circle', { r: 11 }), s('path', { d: 'M-4 -4L4 4M4 -4L-4 4' }), t);
        tools.push(g);
      }
    }
    edgeLayer.replaceChildren(...kids);
    edgeTools.replaceChildren(...tools);
  }
  function drawMinimap() {
    if (canvas.hidden) return;
    const W = 176, H = 112;
    const r = canvas.getBoundingClientRect();
    const view = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: r.width / vp.zoom, h: r.height / vp.zoom };
    const b = bounds();
    const all = { x: Math.min(b.x, view.x), y: Math.min(b.y, view.y) };
    all.w = Math.max(b.x + b.w, view.x + view.w) - all.x; all.h = Math.max(b.y + b.h, view.y + view.h) - all.y;
    const k = Math.min((W - 12) / all.w, (H - 12) / all.h);
    const ox = 6 + ((W - 12) - all.w * k) / 2, oy = 6 + ((H - 12) - all.h * k) / 2;
    miniMap = { k, ox, oy, all };
    miniSvg.replaceChildren(
      ...S.board.nodes.map((n) => { const g = sizeOf(n); return s('rect', { class: `fb-mini-node t-${n.type}`, x: ox + (n.x - all.x) * k, y: oy + (n.y - all.y) * k, width: Math.max(2, g.w * k), height: Math.max(2, g.h * k), rx: 1 }); }),
      s('rect', { class: 'fb-mini-view', x: ox + (view.x - all.x) * k, y: oy + (view.y - all.y) * k, width: view.w * k, height: view.h * k, rx: 2 }));
  }
  let miniMap = null;
  minimap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const go = (ev) => {
      if (!miniMap) return;
      const rr = miniSvg.getBoundingClientRect();
      const wx = (ev.clientX - rr.left - miniMap.ox) / miniMap.k + miniMap.all.x, wy = (ev.clientY - rr.top - miniMap.oy) / miniMap.k + miniMap.all.y;
      const r = canvas.getBoundingClientRect();
      vp = { ...vp, x: r.width / 2 - wx * vp.zoom, y: r.height / 2 - wy * vp.zoom };
      applyViewport();
    };
    go(e);
    minimap.setPointerCapture(e.pointerId);
    minimap.onpointermove = go;
    minimap.onpointerup = () => { minimap.onpointermove = null; };
  });

  /* ---------- Elegir, agregar y borrar ---------- */

  function pick(ids, { add = false, focus = false } = {}) {
    if (!add) S.sel.clear();
    for (const nid of ids) S.sel.add(nid);
    S.edge = null;
    S.boardPanel = false;
    refresh({ inspector: true });
    // Desde un clic sobre el lienzo, el navegador mueve el foco al elemento después del evento: se enfoca un instante después.
    const first = () => inspector.querySelector('textarea, input:not([type=checkbox]):not([type=radio]), select')?.focus({ preventScroll: true });
    if (focus && ids.length === 1) { if (focus === 'later') setTimeout(first, 30); else first(); }
  }
  /** Lugar libre cerca de (x, y): baja mientras choque con otro elemento. */
  function placeFree(x, y, w = NODE_W, hgt = 140) {
    for (let guard = 0; guard < 40; guard++) {
      const hit = S.board.nodes.find((n) => { const g = sizeOf(n); return x < n.x + g.w + 24 && x + w + 24 > n.x && y < n.y + g.h + 24 && y + hgt + 24 > n.y; });
      if (!hit) break;
      y = hit.y + sizeOf(hit).h + GAP;
    }
    return { x: Math.round(x / SNAP) * SNAP, y: Math.round(y / SNAP) * SNAP };
  }
  function addNode(spec, at) {
    const n = { id: newId(spec.type[0]), type: spec.type, x: 0, y: 0, data: spec.data };
    Object.assign(n, placeFree(at.x, at.y, n.type === 'note' || n.type === 'image' ? n.data.w : NODE_W));
    S.board.nodes.push(n);
    return n;
  }
  function connect(from, port, to) {
    S.board.edges = S.board.edges.filter((e) => !(e.from === from && e.port === port));
    if (to) S.board.edges.push({ id: newId('e'), from, port, to });
  }
  /** Agrega lo nuevo después de lo elegido (y lo une); si no hay nada elegido, en el centro de la vista. */
  /** El último elemento de la línea principal (donde se sigue escribiendo el flujo). */
  function mainTail() {
    let cur = S.board.nodes.find((n) => n.type === 'trigger');
    for (let guard = 0, e = cur && edgeFrom(cur.id); e && guard < 300; guard++, e = edgeFrom(cur.id)) { const nx = byId(e.to); if (!nx || nx === cur) break; cur = nx; }
    return cur;
  }
  function addFromPalette(make, at) {
    const spec = make();
    const picked = S.sel.size === 1 ? byId([...S.sel][0]) : null;
    const tail = !picked && !at && FLOW.has(spec.type) ? mainTail() : null;
    const sel = picked ?? (tail && !edgeFrom(tail.id) ? tail : null);
    let n;
    if (!at && canChain(sel) && FLOW.has(spec.type)) {
      const g = sizeOf(sel);
      const next = edgeFrom(sel.id);
      n = addNode(spec, { x: sel.x + (g.w - NODE_W) / 2, y: sel.y + g.h + GAP });
      connect(sel.id, 'out', n.id);
      if (next && canChain(n)) connect(n.id, 'out', next.to);
    } else {
      const r = canvas.getBoundingClientRect();
      const b = bounds();
      n = addNode(spec, at ?? (canvas.hidden ? { x: b.x, y: b.y + b.h + GAP } : toWorld(r.left + r.width / 2 - (NODE_W / 2) * vp.zoom, r.top + r.height / 3)));
    }
    commit();
    pick([n.id], { focus: !isPhone() });
    if (!canvas.hidden) ensureVisible(n);
    if (n.type === 'image') pickPhoto(n.data, { board: true });
  }
  function ensureVisible(n) {
    requestAnimationFrame(() => {
      const r = canvas.getBoundingClientRect();
      const g = sizeOf(n);
      const sx = n.x * vp.zoom + vp.x, sy = n.y * vp.zoom + vp.y;
      if (sx < 40 || sy < 40 || sx + g.w * vp.zoom > r.width - 40 || sy + g.h * vp.zoom > r.height - 40) centerOn(n);
    });
  }
  function removeSelected() {
    if (S.edge) { S.board.edges = S.board.edges.filter((e) => e.id !== S.edge); S.edge = null; commit({ inspector: true }); return; }
    if (!S.sel.size) return;
    const gone = new Set(S.sel);
    for (const nid of gone) if (byId(nid)?.type === 'trigger' && S.board.nodes.filter((n) => n.type === 'trigger').length === 1) { gone.delete(nid); toast('El inicio no se borra: cámbialo en sus propiedades.', true); }
    S.board.nodes = S.board.nodes.filter((n) => !gone.has(n.id));
    S.board.edges = S.board.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    S.sel.clear();
    commit({ inspector: true });
  }
  function duplicateSelected() {
    const ids = [...S.sel].filter((nid) => byId(nid) && byId(nid).type !== 'trigger');
    if (!ids.length) return;
    const map = new Map();
    for (const nid of ids) {
      const o = byId(nid);
      const c = JSON.parse(JSON.stringify(o));
      c.id = newId(o.type[0]); c.x += 32; c.y += 32;
      if (c.type === 'message') for (const b of c.data.buttons) { const old = b.id; b.id = newId('b'); map.set(`${nid}|b:${old}`, `b:${b.id}`); }
      map.set(nid, c.id);
      S.board.nodes.push(c);
    }
    for (const e of [...S.board.edges]) {
      if (map.has(e.from) && map.has(e.to)) S.board.edges.push({ id: newId('e'), from: map.get(e.from), port: e.port === 'out' ? 'out' : map.get(`${e.from}|${e.port}`), to: map.get(e.to) });
    }
    commit();
    pick(ids.map((nid) => map.get(nid)));
  }

  /* ---------- Ordenar ---------- */

  function tidy({ record = true, notes = true } = {}) {
    const t = S.board.nodes.find((n) => n.type === 'trigger');
    if (!t) return;
    measure();
    const placed = new Set();
    const colW = NODE_W + 104;
    let maxCol = 0;
    const walk = (startId, col, y) => {
      for (let cur = byId(startId); cur && FLOW.has(cur.type) && !placed.has(cur.id);) {
        cur.x = t.x + col * colW; cur.y = y; placed.add(cur.id);
        y += sizeOf(cur).h + GAP;
        if (cur.type === 'message') {
          const skip = ahead(cur.id);
          for (const b of cur.data.buttons) {
            const e = edgeFrom(cur.id, `b:${b.id}`);
            if (!e || placed.has(e.to) || skip.has(e.to)) continue;
            maxCol += 1;
            walk(e.to, maxCol, cur.y + (geo.get(cur.id)?.ports[`b:${b.id}`]?.dy ?? 0) + GAP / 2);
          }
        }
        const nx = edgeFrom(cur.id);
        cur = nx ? byId(nx.to) : null;
      }
    };
    walk(t.id, 0, t.y);
    // Las notas y fotos de la pizarra quedan en una columna a la izquierda de la línea principal.
    let ny = t.y;
    if (notes) for (const n of S.board.nodes.filter((x) => BOARD_ONLY.has(x.type))) { n.x = t.x - sizeOf(n).w - 72; n.y = ny; ny += sizeOf(n).h + 24; }
    if (record) commit(); else { last = snap(); scheduleSave(); refresh(); }
    fit({ readable: true });
  }

  /* ---------- Interacción con el lienzo ---------- */

  const pointers = new Map();
  let drag = null;
  let raf = 0;
  let lastTap = null;
  const frame = (fn) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fn); };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('.fb-zoom, .fb-minimap, .fb-conflict, input, textarea, select, button, [contenteditable=true], [contenteditable=plaintext-only]')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      drag = { kind: 'pinch', dist: Math.hypot(p.x - q.x, p.y - q.y) || 1, zoom: vp.zoom, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, vp: { ...vp } };
      return;
    }
    const wp = toWorld(e.clientX, e.clientY);
    const port = e.target.closest('.fb-port[data-port]');
    const resize = e.target.closest('[data-resize]');
    const nodeEl = e.target.closest('.fb-node');
    const hit = e.target.closest('[data-edge]');
    const del = e.target.closest('[data-edge-del]');
    // Doble clic o doble toque: editar lo que hay ahí, o agregar algo en el fondo.
    const key = nodeEl?.dataset.id ?? 'fondo';
    const now = performance.now();
    const double = !port && !resize && lastTap && now - lastTap.t < 360 && lastTap.key === key && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 10;
    lastTap = double ? null : { t: now, key, x: e.clientX, y: e.clientY };
    if (double) {
      const n = nodeEl && byId(key);
      if (n && (n.type === 'note' || n.type === 'text')) { pick([n.id]); requestAnimationFrame(() => editInline(n)); }
      else if (n) pick([n.id], { focus: 'later' });
      else quickAdd(null, null, wp, e.clientX, e.clientY);
      return;
    }
    if (del) { S.board.edges = S.board.edges.filter((x) => x.id !== del.dataset.edgeDel); S.edge = null; commit({ inspector: true }); return; }
    canvas.setPointerCapture(e.pointerId);
    if (port && nodeEl) { e.preventDefault(); drag = { kind: 'connect', from: nodeEl.dataset.id, port: port.dataset.port, moved: false }; return; }
    if (resize && nodeEl) { const n = byId(nodeEl.dataset.id); drag = { kind: 'resize', n, start: wp, w: n.data.w, h: n.data.h ?? 0 }; return; }
    if (nodeEl) {
      const nid = nodeEl.dataset.id;
      if (e.shiftKey || e.metaKey || e.ctrlKey) { if (S.sel.has(nid)) S.sel.delete(nid); else S.sel.add(nid); S.edge = null; S.boardPanel = false; refresh({ inspector: true }); }
      else if (!S.sel.has(nid)) { S.sel.clear(); S.sel.add(nid); S.edge = null; S.boardPanel = false; refresh({ inspector: true }); }
      drag = { kind: 'move', start: wp, orig: [...S.sel].map(byId).filter(Boolean).map((n) => [n, n.x, n.y]), moved: false };
      return;
    }
    if (hit) { S.sel.clear(); S.edge = hit.dataset.edge; refresh({ inspector: true }); return; }
    drag = e.shiftKey ? { kind: 'marquee', start: { x: e.clientX, y: e.clientY }, wstart: wp } : { kind: 'pan', start: { x: e.clientX, y: e.clientY }, vp: { ...vp }, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (drag.kind === 'pinch') {
      if (pointers.size < 2) return;
      const [p, q] = [...pointers.values()];
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const r = canvas.getBoundingClientRect();
      vp = { ...drag.vp };
      zoomAt(drag.mid.x - r.left, drag.mid.y - r.top, drag.zoom * (Math.hypot(p.x - q.x, p.y - q.y) / drag.dist));
      vp = { ...vp, x: vp.x + mid.x - drag.mid.x, y: vp.y + mid.y - drag.mid.y };
      applyViewport();
      return;
    }
    const wp = toWorld(e.clientX, e.clientY);
    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.start.x, dy = e.clientY - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; canvas.classList.add('is-panning'); }
      vp = { ...drag.vp, x: drag.vp.x + dx, y: drag.vp.y + dy };
      frame(applyViewport);
    } else if (drag.kind === 'move') {
      const dx = wp.x - drag.start.x, dy = wp.y - drag.start.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4 / vp.zoom) return;
      drag.moved = true;
      for (const [n, x0, y0] of drag.orig) {
        n.x = Math.round((x0 + dx) / SNAP) * SNAP; n.y = Math.round((y0 + dy) / SNAP) * SNAP;
        const el = els.get(n.id)?.el;
        if (el) el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      }
      frame(() => { drawEdges(); drawMinimap(); });
    } else if (drag.kind === 'connect') {
      drag.moved = true;
      const a = portPoint(byId(drag.from), drag.port);
      if (a) ghost.setAttribute('d', route(a, wp, drag.port === 'out' ? 'bottom' : 'right').d);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fb-node');
      canvas.querySelectorAll('.fb-node.is-drop').forEach((x) => x.classList.remove('is-drop'));
      const target = over && byId(over.dataset.id);
      if (validTarget(target) && (target.id !== drag.from || drag.port !== 'out')) over.classList.add('is-drop');
    } else if (drag.kind === 'resize') {
      const n = drag.n;
      n.data.w = Math.round(Math.min(n.type === 'image' ? 1200 : 800, Math.max(n.type === 'image' ? 80 : 120, drag.w + wp.x - drag.start.x)) / SNAP) * SNAP;
      if (n.type === 'note') n.data.h = Math.round(Math.min(800, Math.max(80, drag.h + wp.y - drag.start.y)) / SNAP) * SNAP;
      frame(() => renderNodes());
    } else if (drag.kind === 'marquee') {
      const r = canvas.getBoundingClientRect();
      Object.assign(marquee.style, { left: `${Math.min(e.clientX, drag.start.x) - r.left}px`, top: `${Math.min(e.clientY, drag.start.y) - r.top}px`, width: `${Math.abs(e.clientX - drag.start.x)}px`, height: `${Math.abs(e.clientY - drag.start.y)}px` });
      marquee.hidden = false;
      drag.end = wp;
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (!drag) return;
    const d = drag;
    if (d.kind === 'pinch') { if (pointers.size < 2) drag = null; return; }
    drag = null;
    canvas.classList.remove('is-panning');
    if (d.kind === 'pan' && !d.moved) { if (S.sel.size || S.edge || S.boardPanel) { S.sel.clear(); S.edge = null; S.boardPanel = false; refresh({ inspector: true }); } }
    else if (d.kind === 'move' && d.moved) commit();
    else if (d.kind === 'resize') commit();
    else if (d.kind === 'marquee') {
      marquee.hidden = true;
      if (d.end) {
        const x0 = Math.min(d.wstart.x, d.end.x), x1 = Math.max(d.wstart.x, d.end.x), y0 = Math.min(d.wstart.y, d.end.y), y1 = Math.max(d.wstart.y, d.end.y);
        pick(S.board.nodes.filter((n) => { const g = sizeOf(n); return n.x < x1 && n.x + g.w > x0 && n.y < y1 && n.y + g.h > y0; }).map((n) => n.id));
      }
    } else if (d.kind === 'connect') {
      ghost.setAttribute('d', '');
      canvas.querySelectorAll('.fb-node.is-drop').forEach((x) => x.classList.remove('is-drop'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fb-node');
      const target = over && byId(over.dataset.id);
      if (validTarget(target) && (target.id !== d.from || d.port !== 'out')) { connect(d.from, d.port, target.id); commit(); }
      else if (d.moved && !over && e.type === 'pointerup') quickAdd(d.from, d.port, toWorld(e.clientX, e.clientY), e.clientX, e.clientY);
      else if (!d.moved) pick([d.from]);
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => {
    if (e.target.closest('.fb-zoom, .fb-minimap')) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, vp.zoom * Math.exp(-e.deltaY * 0.0045));
    else { vp = { ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY }; frame(applyViewport); }
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const nodeEl = e.target.closest?.('.fb-node');
    if (nodeEl && !e.target.isContentEditable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick([nodeEl.dataset.id], { focus: true }); }
  });

  /** Menú para crear lo que sigue al soltar una línea en un lugar vacío (o con doble clic en el fondo). */
  function quickAdd(from, port, at, cx, cy) {
    editor.querySelector('.fb-quick')?.remove();
    const src = from ? byId(from) : null;
    const isButton = !!port && port !== 'out';
    const keys = ['message', 'wait'];
    if (!src || isButton || src.type === 'trigger' || src.type === 'action') keys.push('tag', 'handoff', ...(isButton ? [] : ['alert']), 'flow');
    keys.push('end');
    if (!src) keys.push('note', 'text');
    const LABEL = { message: ['Mensaje', 'chat'], wait: ['Espera', 'clock'], tag: ['Poner una etiqueta', 'tag'], handoff: ['Pasar con una persona', 'user'], alert: ['Avisar al equipo', 'bell'], flow: ['Empezar otro flujo', 'branch'], end: ['Terminar el flujo', 'flag'], note: ['Nota', 'note'], text: ['Texto', 'type'] };
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (ev) => { if (!menu.contains(ev.target)) close(); };
    const menu = h('div', { class: 'fb-quick fb-menu', role: 'menu', 'aria-label': src ? 'Qué sigue' : 'Agregar aquí',
      onkeydown: (ev) => {
        const list = [...menu.querySelectorAll('[role=menuitem]')];
        const i = list.indexOf(document.activeElement);
        if (ev.key === 'Escape') { ev.preventDefault(); close(); canvas.focus(); }
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); list[(i + (ev.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus(); }
      } },
      h('div', { class: 'fb-menu-title small muted' }, src ? 'Qué sigue' : 'Agregar aquí'),
      keys.map((key) => h('button', { type: 'button', role: 'menuitem', onclick: () => {
        close();
        const spec = SPECS[key]();
        const n = addNode(spec, { x: at.x - (spec.type === 'note' ? 110 : NODE_W / 2), y: at.y });
        if (src) connect(src.id, port, n.id);
        commit();
        pick([n.id], { focus: !isPhone() });
        ensureVisible(n);
      } }, h('span', { class: `fb-tile t-${toneOf(key)}`, 'aria-hidden': 'true' }, icon(LABEL[key][1], 14)), LABEL[key][0])));
    const r = editor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(cx - r.left, r.width - 236))}px`;
    menu.style.top = `${Math.max(8, Math.min(cy - r.top, r.height - (keys.length * 40 + 48)))}px`;
    editor.append(menu);
    document.addEventListener('pointerdown', outside, true);
    menu.querySelector('[role=menuitem]')?.focus();
  }

  /** Arrastrar desde la paleta: suelta el elemento donde quedó el puntero (con el dedo, tocar ya lo agrega). */
  function paletteDrag(e, key, label, iconName) {
    if (e.button > 0 || e.pointerType === 'touch') return;
    const start = { x: e.clientX, y: e.clientY };
    let ghostEl = null;
    const move = (ev) => {
      if (!ghostEl && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      if (!ghostEl) { ghostEl = h('div', { class: 'fb-drag-ghost' }, h('span', { class: `fb-tile t-${toneOf(key)}` }, icon(iconName, 16)), label); document.body.append(ghostEl); }
      ghostEl.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 10}px)`;
    };
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!ghostEl) return;
      ghostEl.remove();
      const r = canvas.getBoundingClientRect();
      if (canvas.hidden || ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
      const wp = toWorld(ev.clientX, ev.clientY);
      addFromPalette(SPECS[key], { x: wp.x - NODE_W / 2, y: wp.y - 20 });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  /* ---------- Teclado ---------- */

  const onKey = (e) => {
    if (!editor.isConnected || document.querySelector('dialog[open]')) return;
    const typing = e.target.closest?.('input, textarea, select') || e.target.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') { e.preventDefault(); flush().then(() => toast(S.conflict ? 'No se guardó: cambió en otra pestaña' : 'Guardado')); return; }
    if (typing) return;
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') {
      if (editor.querySelector('.fb-menu')) return;
      if (S.panel) { closePanel(); return; }
      if (S.sel.size || S.edge || S.boardPanel) { S.sel.clear(); S.edge = null; S.boardPanel = false; refresh({ inspector: true }); canvas.focus({ preventScroll: true }); }
      return;
    }
    if (inspector.contains(e.target) || panel.contains(e.target)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel.size || S.edge) { e.preventDefault(); removeSelected(); } return; }
    if (mod && key === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (S.view !== 'canvas' || mod) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(1 / 1.2);
    else if (key === 'f') fit();
    else if (e.key.startsWith('Arrow') && S.sel.size) {
      e.preventDefault();
      const step = e.shiftKey ? 40 : SNAP;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      for (const nid of S.sel) { const n = byId(nid); n.x += dx; n.y += dy; }
      commit({ coalesce: true });
    }
  };
  document.addEventListener('keydown', onKey);
  const beforeUnload = (e) => { if (S.dirty || S.saveState === 'saving') { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  const onResize = () => { if (!isNarrow() && S.view === 'list') setView('canvas'); drawMinimap(); };
  window.addEventListener('resize', onResize);
  state.timers.push(() => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('resize', onResize);
    if (S.dirty) { clearTimeout(saveTimer); save(); }
  });

  /* ---------- Encabezado: nombre, estado y guardado ---------- */

  function setSave(st, msg = '') {
    S.saveState = st;
    const words = { pending: 'Sin guardar', saving: 'Guardando…', saved: 'Guardado', error: 'No se guardó', conflict: 'No se guardó' };
    fill(saveEl, words[st], st === 'error' ? [' · ', h('button', { type: 'button', class: 'fb-link', onclick: () => { scheduleSave(); save(); } }, 'Reintentar')] : null);
    saveEl.title = msg;
    saveEl.dataset.state = st;
    conflictBar.hidden = st !== 'conflict';
    updateStatus();
  }
  function updateStatus() {
    const [tone, label] = boardStatus(S);
    statusEl.className = `badge ${tone}`;
    statusEl.textContent = label;
    undoBtn.disabled = !past.length;
    redoBtn.disabled = !future.length;
    fill(publishBtn, 'Publicar', S.pending ? h('span', { class: 'fb-publish-more' }, ' cambios') : null);
  }
  async function rename() {
    const input = h('input', { value: S.name, maxlength: 120, required: true });
    const ok = await dialog('Nombre del flujo', field('Nombre', input, 'Así se llaman la regla y los flujos que se publican.'), 'Guardar', () => input.reportValidity());
    const name = input.value.trim();
    if (!ok || !name || name === S.name) return;
    S.name = name;
    titleBtn.textContent = name;
    document.title = document.title.replace(/^.*·/, `${name} ·`);
    scheduleSave();
  }
  /** Pendientes del elemento elegido, arriba de sus propiedades (se actualizan al guardar, sin quitar el foco). */
  function problemBox(n) {
    const probs = problemsFor(n.id);
    return h('ul', { class: 'fb-insp-problems', hidden: !probs.length, 'aria-live': 'polite' }, probs.map((p) => h('li', { class: p.warning ? 'warn' : '' }, icon('alert', 14), h('span', {}, p.message))));
  }
  function refreshProblems() {
    const box = inspector.querySelector('.fb-insp-problems');
    const chosen = S.sel.size === 1 ? byId([...S.sel][0]) : null;
    if (box && chosen) box.replaceWith(problemBox(chosen));
    const errors = S.problems.filter((p) => !p.warning).length;
    countEl.textContent = errors ? String(errors) : '';
    problemsBtn.classList.toggle('has', errors > 0);
    problemsBtn.setAttribute('aria-label', errors ? `Pendientes: ${errors}` : 'Pendientes: ninguno');
    renderNodes();
    if (S.view === 'list') renderOutline();
    if (S.panel === 'problems') renderProblems();
    if (!S.sel.size && !S.edge) renderInspector();
  }

  /* ---------- Menú «más» ---------- */

  function openMenu(anchor) {
    editor.querySelector('.fb-menu')?.remove();
    const close = () => { menu.remove(); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
    const outside = (ev) => { if (!menu.contains(ev.target) && !anchor.contains(ev.target)) close(); };
    const item = (label, iconName, fn, cls = '') => h('button', { type: 'button', role: 'menuitem', class: cls, onclick: () => { close(); fn(); } }, icon(iconName, 16), label);
    const published = S.published_revision !== null && S.published_revision !== undefined;
    const visible = () => [...menu.querySelectorAll('[role=menuitem]')].filter((x) => x.offsetParent);
    const menu = h('div', { class: 'fb-menu fb-more', role: 'menu', 'aria-label': 'Más opciones',
      onkeydown: (ev) => {
        const list = visible();
        const i = list.indexOf(document.activeElement);
        if (ev.key === 'Escape') { ev.preventDefault(); close(); anchor.focus(); }
        else if (ev.key === 'Tab') close();
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); list[(i + (ev.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus(); }
      } },
      item('Deshacer', 'undo', undo, 'fb-narrow-only'), item('Rehacer', 'redo', redo, 'fb-narrow-only'),
      item('Vista previa', 'play', () => openPanel('preview'), 'fb-narrow-only'),
      item('Instrucciones del agente', 'bot', () => openPanel('agent'), 'fb-narrow-only'),
      item('Cambiar con IA', 'wand', () => openPanel('ai'), 'fb-narrow-only'),
      item(`Pendientes${countEl.textContent ? ` (${countEl.textContent})` : ''}`, 'alert', () => openPanel('problems'), 'fb-narrow-only'),
      item('Ajustes del flujo', 'settings', () => { S.sel.clear(); S.edge = null; S.boardPanel = true; refresh({ inspector: true }); }),
      item('Ordenar el flujo', 'layout', () => { if (S.view !== 'canvas') setView('canvas'); tidy(); }),
      published ? item(S.paused ? 'Reanudar' : 'Pausar', S.paused ? 'play' : 'pause', togglePause) : null,
      item('Duplicar', 'copy', duplicateBoard),
      item('Eliminar', 'trash', removeBoard, 'danger'));
    anchor.setAttribute('aria-expanded', 'true');
    const r = anchor.getBoundingClientRect(), er = editor.getBoundingClientRect();
    menu.style.top = `${r.bottom - er.top + 6}px`;
    menu.style.right = `${Math.max(8, er.right - r.right)}px`;
    editor.append(menu);
    document.addEventListener('pointerdown', outside, true);
    visible()[0]?.focus();
  }
  async function togglePause() {
    try {
      const r = await api('POST', `/api/flow-boards/${id}/pause`, { paused: !S.paused });
      S.paused = r.paused;
      updateStatus();
      toast(S.paused ? 'En pausa: no empieza con nadie nuevo y quienes iban en él se detienen' : 'Reanudado: el flujo vuelve a funcionar');
    } catch (e) { toast(e.message, true); }
  }
  async function duplicateBoard() {
    await flush();
    try { const r = await api('POST', `/api/flow-boards/${id}/duplicate`); toast('Copia creada (sin publicar)'); location.hash = `#/automation/lienzo/${r.id}`; }
    catch (e) { toast(e.message, true); }
  }
  async function removeBoard() {
    const published = S.published_revision !== null && S.published_revision !== undefined;
    if (!(await confirmAction(published ? `¿Eliminar «${S.name}»? También se borran su regla y sus flujos publicados, y quienes van en ellos se detienen.` : `¿Eliminar «${S.name}»?`, 'Eliminar'))) return;
    try { clearTimeout(saveTimer); S.dirty = false; await api('DELETE', `/api/flow-boards/${id}`); toast('Flujo eliminado'); location.hash = '#/automation/lienzo'; }
    catch (e) { toast(e.message, true); }
  }

  /* ---------- Publicar ---------- */

  async function publish() {
    publishBtn.disabled = true;
    try {
      await flush();
      if (S.conflict) return;
      // Si el último cambio no llegó al servidor, publicar mandaría la versión anterior.
      if (S.dirty || S.saveState === 'error') { toast('Tu último cambio no se guardó, así que aún no se publica. Revisa tu conexión y toca «Reintentar».', true); return; }
      const r = await api('POST', `/api/flow-boards/${id}/publish`, { revision: S.revision });
      S.published_revision = r.published_revision; S.published_at = r.published_at; S.problems = r.problems; S.pending = false;
      refreshProblems();
      updateStatus();
      const msgs = r.sequences.reduce((n, q) => n + q.messages, 0);
      await notice('Flujo publicado', h('div', { class: 'fb-published' },
        h('p', {}, S.paused ? 'Se guardó la versión nueva; el flujo sigue en pausa.' : 'Ya está funcionando en todos tus canales.'),
        h('ul', { class: 'fb-published-list' },
          h('li', {}, icon('zap', 16), r.automation_id ? h('span', {}, 'Una regla que lo inicia: ', h('a', { href: '#/automation/rules' }, S.name)) : h('span', {}, 'Sin regla: lo inicias tú desde una conversación o enviándolo a un grupo')),
          h('li', {}, icon('chat', 16), h('span', {}, `${r.sequences.length} ${r.sequences.length === 1 ? 'flujo' : 'flujos'} con ${msgs} ${msgs === 1 ? 'mensaje' : 'mensajes'}: `, h('a', { href: '#/automation/sequences' }, 'verlos en Flujos')))),
        h('p', { class: 'small muted' }, 'Si lo cambias y vuelves a publicar, se actualizan los mismos: quienes ya van en él siguen con la versión nueva.')));
    } catch (e) {
      if (e.status === 400) { await save(); openPanel('problems', e.issues ?? [e.message]); }
      else toast(e.message, true);
    } finally { publishBtn.disabled = false; }
  }

  /* ---------- Paneles: pendientes, vista previa e instrucciones del agente ---------- */

  function openPanel(kind, extra = []) {
    S.panel = kind;
    panel.hidden = false;
    editor.classList.add('has-panel');
    panelTitle.textContent = { problems: 'Pendientes', preview: 'Vista previa', agent: 'Instrucciones del agente', ai: 'Cambiar con IA' }[kind];
    if (kind === 'problems') renderProblems(extra);
    else if (kind === 'preview') fill(panelBody, previewPanel({ board: S.board, files, fileUrl, onShow: (nid) => { const n = byId(nid); if (!n || canvas.hidden) return; S.sel.clear(); S.sel.add(nid); refresh(); centerOn(n); } }));
    else if (kind === 'ai') fill(panelBody, aiPanel(extra));
    else fill(panelBody, agentPanel({ bots, board: S.board, name: S.name, context: flowContext() }));
    if (kind === 'ai' && !isPhone()) panelBody.querySelector('textarea')?.focus();
    else panel.querySelector('.fb-panel-head button')?.focus();
  }

  /** El flujo en palabras, para que la IA entienda de qué se habla al cambiar las instrucciones del agente. */
  function flowContext() {
    const t = S.board.nodes.find((n) => n.type === 'trigger');
    const msgs = S.board.nodes.filter((n) => n.type === 'message' && n.data.text.trim()).slice(0, 6).map((n) => `- ${clip(n.data.text, 160)}`);
    return [`Flujo «${S.name}»: ${t ? describe(t) : 'sin inicio'}.`, msgs.length ? `Sus mensajes:\n${msgs.join('\n')}` : ''].filter(Boolean).join('\n');
  }

  /* ---------- Cambiar con IA ---------- */

  let aiLast = null;
  /** Panel para pedir un cambio en palabras (o con una foto). `intro`: lo que hizo la IA al crear el flujo. */
  function aiPanel(intro) {
    const slot = h('div', { class: 'ai-slot' });
    const errors = () => S.problems.filter((p) => !p.warning).length;
    const show = (r, undoable) => fill(slot, aiResult({
      title: undoable ? 'Cambio hecho' : 'Tu flujo está listo',
      summary: r.summary, review: r.review ?? [], errors: errors(),
      onProblems: () => openPanel('problems'),
      onUndo: undoable ? () => { if (undoAi()) fill(slot, h('p', { class: 'help', role: 'status' }, 'Deshiciste el cambio. El flujo quedó como estaba.')); } : null,
    }));
    const composer = ideaComposer({
      id: `fb-ai-idea-${id}`,
      label: '¿Qué quieres cambiar, agregar o quitar?',
      placeholder: 'Ejemplo: agrega un botón «Ubicación» que mande la dirección y cambia la espera a 2 días.',
      examples: EDIT_EXAMPLES,
      submit: 'Hacer el cambio',
      steps: AI_STEPS,
      onSubmit: async ({ idea, file }) => {
        const sent = snap();
        const r = await requestDesign({ url: inAcct('/api/flow-boards/ai'), idea, file, name: S.name, board: { nodes: S.board.nodes, edges: S.board.edges, settings: S.board.settings } });
        if (!editor.isConnected) return;
        // Si se editó el lienzo mientras la IA trabajaba, aplicar su versión borraría esos cambios.
        if (snap() !== sent) throw new Error('Cambiaste el lienzo mientras la IA trabajaba: vuelve a pedir el cambio para no perder lo que hiciste.');
        applyAi(r);
        composer.reset();
        show(r, true);
        if (!composer.el.isConnected) toast('La IA hizo el cambio en el lienzo. Puedes deshacerlo.');
      },
    });
    if (intro?.summary || intro?.review?.length) show(intro, false);
    return [
      h('p', { class: 'help' }, 'Cuéntalo como a alguien de tu equipo, o sube una foto (tu dibujo, un volante, una captura). El cambio se ve en el lienzo y puedes deshacerlo.'),
      slot,
      composer.el,
    ];
  }
  /** Pone en el lienzo lo que armó la IA y lo ordena; todo queda como un solo paso de «Deshacer». */
  function applyAi(r) {
    if (r.photo && !files.some((f) => f.id === r.photo.id)) files.unshift(r.photo);
    const had = new Set(S.board.nodes.filter((n) => FLOW.has(n.type)).map((n) => n.id));
    S.board.nodes = r.board.nodes; S.board.edges = r.board.edges; S.board.settings = r.board.settings;
    S.problems = r.problems ?? S.problems;
    S.sel.clear(); S.edge = null; S.boardPanel = false;
    if (S.board.nodes.some((n) => FLOW.has(n.type) && !had.has(n.id))) {
      // Con elementos nuevos se ordena la línea (con sus medidas reales); las notas se quedan donde las pusiste.
      const back = S.view;
      setView('canvas');
      tidy({ notes: false });
      if (back !== 'canvas') setView(back);
    } else commit();
    aiLast = last;
    refreshProblems();
    renderInspector();
  }
  function undoAi() {
    if (!aiLast) return false;
    if (last !== aiLast) { toast('Hiciste otros cambios después: usa Deshacer de arriba, paso por paso.', true); return false; }
    undo();
    aiLast = null;
    return true;
  }
  function closePanel() {
    S.panel = null;
    panel.hidden = true;
    editor.classList.remove('has-panel');
    fill(panelBody);
  }
  function renderProblems(extra = []) {
    const errors = S.problems.filter((p) => !p.warning);
    const warnings = S.problems.filter((p) => p.warning);
    const item = (p) => {
      const n = byId(p.node);
      return h('li', {}, h('button', { type: 'button', class: `fb-problem${p.warning ? ' warn' : ''}`, disabled: !n, onclick: () => { closePanel(); if (S.view === 'canvas') centerOn(n); pick([n.id], { focus: true }); } },
        h('span', { class: 'fb-problem-what' }, n ? `${kindLabel(n)} · ${describe(n)}` : 'El flujo'),
        h('span', {}, p.message)));
    };
    const others = extra.filter((m) => !S.problems.some((p) => p.message === m));
    fill(panelBody,
      errors.length || others.length ? h('p', { class: 'help' }, 'Resuelve esto para publicar. Toca uno para ir a él.') : h('p', { class: 'fb-ok' }, icon('check', 16), 'Nada impide publicarlo.'),
      others.length ? h('ul', { class: 'fb-problems' }, others.map((m) => h('li', {}, h('div', { class: 'fb-problem' }, h('span', { class: 'fb-problem-what' }, 'Al publicar'), h('span', {}, m))))) : null,
      errors.length ? h('ul', { class: 'fb-problems' }, errors.map(item)) : null,
      warnings.length ? [h('h3', {}, 'Avisos'), h('ul', { class: 'fb-problems' }, warnings.map(item))] : null);
  }

  /* ---------- Propiedades ---------- */

  const toggle = (obj, key, label, after) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; after?.(); } }), label);
  /** A dónde lleva una salida (la línea principal o un botón): a un elemento, a uno nuevo o a nada. */
  function destField(n, port, label, help) {
    const e = edgeFrom(n.id, port);
    const isButton = port !== 'out';
    const targets = S.board.nodes.filter((t) => validTarget(t) && (t.id !== n.id || isButton));
    const news = [['new:message', '+ Mensaje nuevo'], ['new:wait', '+ Espera nueva']];
    if (isButton || n.type === 'trigger' || n.type === 'action') news.push(['new:tag', '+ Poner una etiqueta'], ['new:handoff', '+ Pasar con una persona'], ['new:flow', '+ Empezar otro flujo']);
    if (!isButton && (n.type === 'trigger' || n.type === 'action')) news.push(['new:alert', '+ Avisar al equipo']);
    news.push(['new:end', '+ Terminar el flujo']);
    const opts = [['', isButton ? 'Nada: el flujo termina' : 'Nada: aquí termina'], ...targets.map((t) => [`node:${t.id}`, t.type === 'action' ? describe(t) : `${kindLabel(t)}: ${describe(t)}`]), ...news];
    const control = h('select', { 'data-auto-label': '1', onchange: (ev) => {
      const v = ev.target.value;
      if (v.startsWith('new:')) {
        const kind = v.slice(4);
        const g = sizeOf(n);
        const t = addNode(SPECS[kind](), isButton ? { x: n.x + g.w + 104, y: n.y } : { x: n.x + (g.w - NODE_W) / 2, y: n.y + g.h + GAP });
        connect(n.id, port, t.id);
      } else connect(n.id, port, v ? v.slice(5) : null);
      commit({ inspector: true });
    } }, opts.map(([v, l]) => h('option', { value: v, selected: e ? v === `node:${e.to}` : v === '' }, l)));
    return field(label, control, help);
  }

  function renderInspector() {
    const sel = [...S.sel].map(byId).filter(Boolean);
    editor.classList.toggle('has-sel', sel.length > 0 || !!S.edge || S.boardPanel);
    const close = h('button', { class: 'fb-icon fb-insp-close', type: 'button', 'aria-label': 'Cerrar', onclick: () => { S.sel.clear(); S.edge = null; S.boardPanel = false; refresh({ inspector: true }); } }, icon('x', 18));
    if (S.edge) {
      const e = S.board.edges.find((x) => x.id === S.edge);
      const a = e && byId(e.from), b = e && byId(e.to);
      const btn = e && e.port !== 'out' ? a?.data.buttons?.find((x) => `b:${x.id}` === e.port) : null;
      fill(inspector, h('div', { class: 'fb-insp-head' }, h('h2', {}, 'Línea'), close),
        h('div', { class: 'fb-insp-body' },
          h('p', { class: 'help' }, btn ? `Al tocar «${btn.label}» en «${describe(a)}», sigue «${describe(b)}».` : `Después de «${describe(a)}» sigue «${describe(b)}».`),
          h('button', { type: 'button', class: 'danger', onclick: () => removeSelected() }, icon('trash', 16), 'Quitar la línea')));
      return;
    }
    if (sel.length > 1) {
      fill(inspector, h('div', { class: 'fb-insp-head' }, h('h2', {}, `${sel.length} elementos elegidos`), close),
        h('div', { class: 'fb-insp-body' },
          h('p', { class: 'help' }, 'Arrástralos juntos, duplícalos o bórralos. Con Mayús y clic agregas o quitas uno.'),
          h('div', { class: 'row' }, h('button', { type: 'button', onclick: duplicateSelected }, icon('copy', 16), 'Duplicar'), h('button', { type: 'button', class: 'danger', onclick: removeSelected }, icon('trash', 16), 'Eliminar'))));
      return;
    }
    if (!sel.length) { boardInspector(close); return; }
    const n = sel[0];
    const d = n.data;
    const body = h('div', { class: 'fb-insp-body' }, problemBox(n));
    if (n.type === 'trigger') triggerForm(body, n);
    else if (n.type === 'message') messageForm(body, n);
    else if (n.type === 'wait') {
      body.append(
        h('div', { class: 'fb-inline' },
          field('Esperar', h('input', { type: 'number', min: 0, max: 10000, value: d.value, oninput: (e) => { d.value = Math.max(0, Math.min(10000, Math.round(Number(e.target.value) || 0))); } })),
          field('Unidad', select(d, 'unit', UNITS))),
        field('A esta hora (opcional)', h('input', { type: 'time', value: d.at_time, oninput: (e) => { d.at_time = e.target.value; } }), 'Ej.: al día siguiente a las 10:00. Lo que caiga fuera de horario sale en la siguiente apertura.'),
        destField(n, 'out', 'Después de esperar'));
    } else if (n.type === 'action') actionForm(body, n);
    else if (n.type === 'note') {
      body.append(
        field('Nota', area(d, 'text', { rows: 6, maxlength: 2000, placeholder: 'Una idea, un pendiente o un recordatorio para tu equipo' }), 'Las notas no se publican: solo viven en el lienzo. También puedes escribir directo en ella con doble clic.'),
        h('fieldset', { class: 'field' }, h('legend', {}, 'Color'), h('div', { class: 'fb-swatches' }, NOTE_COLORS.map(([c, label]) => h('label', { class: `fb-swatch c-${c}`, title: label },
          h('input', { type: 'radio', name: `note-color-${n.id}`, value: c, checked: d.color === c, onchange: () => { d.color = c; } }), h('span', { class: 'sr-only' }, label))))));
    } else if (n.type === 'text') {
      body.append(field('Texto', area(d, 'text', { rows: 3, maxlength: 400 })), field('Tamaño', select(d, 'size', [['title', 'Título'], ['body', 'Normal']])));
    } else if (n.type === 'image') {
      body.append(
        h('div', { class: 'fb-insp-photo' }, (d.attachment_id && photoFor(d)) || h('p', { class: 'help' }, 'Sin foto todavía.')),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => pickPhoto(d, { board: true }) }, icon('image', 16), d.attachment_id ? 'Cambiar la foto' : 'Elegir una foto')),
        field('Pie de foto (opcional)', text(d, 'caption', { maxlength: 200 })),
        h('p', { class: 'small muted' }, 'Una foto de referencia para planear: no se envía al cliente. Para enviar una foto, agrégala a un mensaje.'));
    }
    const footer = h('div', { class: 'fb-insp-foot' },
      canChain(n) ? h('div', { class: 'fb-add-after' }, h('span', { class: 'small muted' }, 'Agregar después'),
        h('button', { type: 'button', class: 'small', onclick: () => { S.sel.clear(); S.sel.add(n.id); addFromPalette(SPECS.message); } }, icon('chat', 14), 'Mensaje'),
        h('button', { type: 'button', class: 'small', onclick: () => { S.sel.clear(); S.sel.add(n.id); addFromPalette(SPECS.wait); } }, icon('clock', 14), 'Espera')) : null,
      n.type !== 'trigger' ? h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', onclick: duplicateSelected }, icon('copy', 14), 'Duplicar'),
        h('button', { type: 'button', class: 'small danger', onclick: removeSelected }, icon('trash', 14), 'Eliminar')) : null);
    fill(inspector, h('div', { class: 'fb-insp-head' }, h('span', { class: `fb-tile t-${n.type === 'text' || n.type === 'image' ? 'board' : n.type}`, 'aria-hidden': 'true' }, icon(iconOf(n), 16)), h('h2', {}, kindLabel(n)), close), body, footer);
  }
  inspector.addEventListener('input', () => commit({ coalesce: true }));
  inspector.addEventListener('change', (e) => { if (e.target.matches('select, input[type=checkbox], input[type=radio], input[type=time]')) commit(); });

  function boardInspector(close) {
    const st = S.board.settings;
    const messages = S.board.nodes.filter((n) => n.type === 'message').length;
    const errors = S.problems.filter((p) => !p.warning).length;
    fill(inspector,
      h('div', { class: 'fb-insp-head' }, h('h2', {}, 'Este flujo'), S.boardPanel ? close : null),
      h('div', { class: 'fb-insp-body' },
        h('dl', { class: 'fb-facts' },
          h('div', {}, h('dt', {}, 'Mensajes'), h('dd', { class: 'num' }, messages)),
          h('div', {}, h('dt', {}, 'Pendientes'), h('dd', { class: 'num' }, errors)),
          h('div', {}, h('dt', {}, 'Publicado'), h('dd', {}, S.published_at ? h('time', { datetime: S.published_at, title: fmtDate(S.published_at) }, ago(S.published_at)) : '—'))),
        h('h3', {}, 'Cómo se envía'),
        toggle(st, 'stop_on_reply', 'Se detiene si el cliente responde (tocar un botón no cuenta)'),
        toggle(st, 'business_hours_only', 'Solo en horario del negocio (lo de fuera sale al abrir)'),
        h('h3', {}, 'Para moverte'),
        h('ul', { class: 'fb-keys small' },
          h('li', {}, h('kbd', {}, 'Arrastrar el fondo'), h('span', {}, 'moverte por el lienzo')),
          h('li', {}, h('kbd', {}, 'Ctrl + rueda'), h('span', {}, 'acercar o alejar')),
          h('li', {}, h('kbd', {}, 'Arrastrar un punto'), h('span', {}, 'unir con lo que sigue')),
          h('li', {}, h('kbd', {}, 'Doble clic'), h('span', {}, 'agregar o escribir')),
          h('li', {}, h('kbd', {}, 'Mayús + arrastrar'), h('span', {}, 'elegir varios')),
          h('li', {}, h('kbd', {}, 'Supr'), h('span', {}, 'borrar lo elegido')),
          h('li', {}, h('kbd', {}, 'Ctrl + Z'), h('span', {}, 'deshacer')),
          h('li', {}, h('kbd', {}, 'F'), h('span', {}, 'ver todo')))));
  }

  function triggerForm(body, n) {
    const d = n.data;
    const t = d.trigger;
    const kind = t ? t.type : 'manual';
    const known = STARTS.some(([k]) => k === kind) ? STARTS : [...STARTS, [kind, triggerSummary(t)]];
    body.append(field('Cuándo empieza', h('select', { 'data-auto-label': '1', onchange: (e) => {
      d.trigger = e.target.value === 'manual' ? null : defaultTrigger(e.target.value);
      d.stop_ai = e.target.value === 'message_received';
      commit({ inspector: true });
    } }, known.map(([v, l]) => h('option', { value: v, selected: v === kind }, l)))));
    if (t?.type === 'message_received') {
      body.append(
        field('Cómo coincide', select(t, 'match', [['keywords', 'Contiene alguna de estas palabras'], ['exact', 'Es exactamente una de ellas'], ['contains', 'Contiene el texto en cualquier parte'], ['any', 'Cualquier mensaje']], () => commit({ inspector: true }))),
        t.match !== 'any' ? field('Palabras o frases', lines(t, 'keywords', { placeholder: 'promo\npromoción\nquiero la oferta' }), 'Una por renglón. No distingue mayúsculas ni acentos.') : null,
        toggle(t, 'first_message_only', 'Solo si es su primer mensaje'));
    } else if (t?.type === 'intent') body.append(field('Nombre corto de la intención', text(t, 'intent', { maxlength: 60, placeholder: 'quiere_cotizar' })), field('Cómo la reconoce la IA', area(t, 'description', { rows: 3, maxlength: 300, placeholder: 'El cliente pide precio o cotización de un servicio' })));
    else if (t?.type === 'tag_added') body.append(field('Etiqueta', text(t, 'tag', { maxlength: 60, placeholder: 'interesado' })));
    else if (t?.type === 'no_reply') body.append(field('Minutos sin respuesta', h('input', { type: 'number', min: 1, value: t.minutes, oninput: (e) => { t.minutes = Math.max(1, Math.round(Number(e.target.value) || 1)); } }), '60 = 1 hora · 1440 = 1 día. Cuenta desde nuestro último mensaje.'));
    else if (t?.type === 'appointment_booked') body.append(field('Servicio', select(t, 'service_id', [['', 'Cualquiera'], ...services.map((x) => [x.id, x.name])])));
    else if (t?.type === 'data_captured') body.append(field('Dato (vacío = cualquiera)', text(t, 'field', { maxlength: 80, placeholder: 'correo' })));
    if (t) {
      const hours = d.conditions.find((c) => c.type === 'business_hours');
      const tagCond = d.conditions.find((c) => c.type === 'has_tag' && !c.negate);
      body.append(
        field('Con qué agente', select({ v: d.chatbot_id ?? '' }, 'v', [['', 'Con todos tus agentes'], ...bots.map((b) => [b.id, b.name])], (v) => { d.chatbot_id = v || null; })),
        field('Horario', select({ v: hours ? (hours.inside ? 'in' : 'out') : '' }, 'v', [['', 'A cualquier hora'], ['in', 'Solo en horario del negocio'], ['out', 'Solo fuera de horario']], (v) => {
          d.conditions = d.conditions.filter((c) => c.type !== 'business_hours');
          if (v) d.conditions.push({ type: 'business_hours', inside: v === 'in' });
        })),
        field('Solo si tiene la etiqueta (opcional)', h('input', { value: tagCond?.tag ?? '', placeholder: 'cliente_frecuente', oninput: (e) => {
          d.conditions = d.conditions.filter((c) => !(c.type === 'has_tag' && !c.negate));
          const v = e.target.value.trim();
          if (v) d.conditions.push({ type: 'has_tag', tag: v.slice(0, 60), negate: false });
        } })),
        t.type === 'intent' ? h('p', { class: 'small muted' }, 'Con una intención el agente ya contestó: el flujo sigue después de su respuesta.') : toggle(d, 'stop_ai', 'El agente no contesta ese mensaje: el flujo se encarga'),
        toggle(d, 'once_per_conversation', 'Una sola vez por conversación'));
    } else body.append(h('p', { class: 'help' }, 'Ya publicado, lo envías desde una conversación (Iniciar flujo) o a un grupo de clientes en Campañas.'));
    body.append(destField(n, 'out', 'Lo primero que pasa'));
  }

  function actionForm(body, n) {
    const d = n.data;
    body.append(field('Qué hace', select(d, 'action', Object.entries(ACTIONS).map(([k, a]) => [k, a.label]), () => commit({ inspector: true }))));
    if (d.action === 'tag') body.append(field('Etiqueta', text(d, 'tag', { placeholder: 'promo', maxlength: 60 }), 'Sirve para filtrar contactos, enviar campañas o iniciar otras reglas.'));
    else if (d.action === 'alert') body.append(varsField('Aviso para tu equipo', area(d, 'message', { rows: 3, maxlength: 2000, placeholder: '{{cliente}} pidió la promo: "{{mensaje}}"' }), 'alert'), h('p', { class: 'small muted' }, 'Llega al panel y a quienes reciben avisos por WhatsApp. Solo funciona antes del primer mensaje.'));
    else if (d.action === 'handoff') body.append(field('Motivo (opcional)', text(d, 'reason', { placeholder: 'Quiere apartar', maxlength: 300 }), 'El agente deja de contestar y tu equipo ve el motivo.'));
    else if (d.action === 'flow') {
      const others = sequences.filter((q) => q.board_id !== id);
      body.append(others.length ? field('Flujo que empieza', select(d, 'sequence_id', [['', 'Elige un flujo'], ...others.map((q) => [q.id, q.name])])) : h('p', { class: 'help' }, 'Aún no tienes otros flujos publicados.'));
    } else body.append(h('p', { class: 'help' }, 'Aquí termina el flujo para ese cliente.'));
    if (d.action === 'tag' || d.action === 'alert') body.append(destField(n, 'out', 'Después'));
  }

  function messageForm(body, n) {
    const d = n.data;
    const photo = photoFor(d);
    const replies = d.buttons.filter((b) => b.kind === 'reply').length;
    const urls = d.buttons.length - replies;
    body.append(
      varsField('Mensaje', area(d, 'text', { rows: 5, maxlength: 4000, placeholder: 'Hola {{nombre}}, …' }), 'sequence'),
      photo ? h('div', { class: 'fb-insp-photo' }, photo) : null,
      !photo && d.photo_hint ? h('p', { class: 'fb-missing' }, icon('image', 14), h('span', {}, `Falta la foto: ${d.photo_hint}`),
        h('button', { type: 'button', class: 'fb-link small', onclick: () => { d.photo_hint = ''; commit({ inspector: true }); } }, 'No hace falta')) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: `small${!photo && d.photo_hint ? ' primary' : ''}`, onclick: () => pickPhoto(d) }, icon('image', 14), photo ? 'Cambiar foto o archivo' : 'Agregar foto o archivo'),
        photo ? h('button', { type: 'button', class: 'small danger', onclick: () => { d.image_id = ''; d.attachment_id = ''; commit({ inspector: true }); } }, 'Quitar') : null),
      h('h3', {}, 'Botones'),
      h('p', { class: 'small muted fb-tight' }, 'Hasta 3 de respuesta y 2 de enlace. En WhatsApp con QR salen numerados.'),
      h('div', { class: 'fb-btn-list' }, d.buttons.map((b, i) => {
        const len = h('span', { class: 'small muted fb-len', 'aria-hidden': 'true' }, `${b.label.length}/20`);
        return h('div', { class: 'fb-btn-edit' },
          h('div', { class: 'fb-inline' },
            field(b.kind === 'url' ? 'Texto del enlace' : `Botón ${d.buttons.slice(0, i + 1).filter((x) => x.kind === 'reply').length}`, text(b, 'label', { maxlength: 20, placeholder: b.kind === 'url' ? 'Ver menú' : 'Sí, me interesa', oninput: () => { len.textContent = `${b.label.length}/20`; } })),
            h('button', { type: 'button', class: 'fb-icon', 'aria-label': `Quitar el botón ${b.label || i + 1}`, title: 'Quitar', onclick: () => { d.buttons.splice(i, 1); connect(n.id, `b:${b.id}`, null); commit({ inspector: true }); } }, icon('trash', 16))),
          len,
          b.kind === 'url' ? field('Dirección', text(b, 'url', { type: 'url', placeholder: 'https://…' }), 'Debe empezar con https://')
            : [destField(n, `b:${b.id}`, 'Al tocarlo'),
              h('details', { open: !!b.reply }, h('summary', { class: 'small' }, 'Contestar algo al tocarlo (opcional)'), field('Respuesta', area(b, 'reply', { rows: 2, maxlength: 1000, placeholder: '¡Perfecto! Te cuento…' })))]);
      })),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', disabled: replies >= 3, onclick: () => { if (!replies) d.wait_for_choice = true; d.buttons.push({ id: newId('b'), label: '', kind: 'reply', url: '', reply: '' }); commit({ inspector: true }); [...inspector.querySelectorAll('.fb-btn-edit')].at(-1)?.querySelector('input')?.focus(); } }, icon('plus', 14), 'Botón'),
        h('button', { type: 'button', class: 'small', disabled: urls >= 2, onclick: () => { d.buttons.push({ id: newId('b'), label: '', kind: 'url', url: '', reply: '' }); commit({ inspector: true }); [...inspector.querySelectorAll('.fb-btn-edit')].at(-1)?.querySelector('input')?.focus(); } }, icon('link', 14), 'Enlace')),
      replies ? toggle(d, 'wait_for_choice', 'Esperar a que elija antes del mensaje siguiente', () => commit({ inspector: true })) : null,
      replies && d.wait_for_choice ? field(choiceWindow(n) ? 'Si en 1 día no elige' : 'Si llega la hora de la espera y no eligió', select(d, 'if_no_choice', [['end', 'Terminar el flujo'], ['continue', 'Enviar el siguiente de todos modos']])) : null,
      destField(n, 'out', 'Después de este mensaje', 'Para esperar antes del siguiente, agrega una Espera.'));
  }

  /** Foto o archivo para un mensaje (o una foto de referencia): de tu biblioteca, del catálogo de tus agentes o nueva. */
  async function pickPhoto(d, { board = false } = {}) {
    const grid = h('div', { class: 'fb-photo-grid', role: 'list' });
    let chosen = null;
    const choose = (kind, fid, el) => { chosen = { kind, id: fid }; grid.querySelectorAll('.is-on').forEach((x) => { x.classList.remove('is-on'); x.setAttribute('aria-pressed', 'false'); }); el.classList.add('is-on'); el.setAttribute('aria-pressed', 'true'); };
    const tileFor = (kind, f, label) => {
      const img = h('img', { alt: '', loading: 'lazy' });
      const isFile = kind === 'file' && f.kind !== 'image';
      const b = h('button', { type: 'button', class: 'fb-photo', 'aria-pressed': 'false', 'aria-label': label, onclick: (e) => choose(kind, f.id, e.currentTarget) },
        isFile ? h('span', { class: 'fb-photo-file' }, icon('paperclip', 18)) : img, h('span', { class: 'fb-photo-name small' }, label));
      if (kind === 'file' && !isFile) fileUrl(f).then((u) => { if (u) img.src = u; });
      if (kind === 'catalog') img.src = `/api/images/${f.id}/file`;
      return h('div', { role: 'listitem' }, b);
    };
    const draw = () => fill(grid,
      ...files.filter((f) => !board || f.kind === 'image').map((f) => tileFor('file', f, f.name)),
      ...(board ? [] : catalog.images.map((im) => tileFor('catalog', im, `${im.code || im.name} · ${im.bot}`))));
    const upload = h('input', { type: 'file', accept: board ? '.jpg,.jpeg,.png,.webp' : '.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.mp3,.ogg,.wav,.m4a,.mp4,.mov,.webm', onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      try {
        const created = await api('POST', inAcct('/api/attachments'), form, true);
        files.unshift(created);
        draw();
        choose('file', created.id, grid.querySelector('.fb-photo'));
        toast('Archivo subido: toca «Usar este»');
      } catch (err) { toast(err.message, true); }
    } });
    draw();
    if (!board && !catalog.loaded) {
      catalog.loaded = true;
      Promise.all(bots.slice(0, 6).map((b) => api('GET', `/api/chatbots/${b.id}/images`).then((list) => list.filter((im) => im.active !== false && (im.kind ?? 'image') === 'image').map((im) => ({ ...im, bot: b.name }))).catch(() => [])))
        .then((lists) => { catalog.images = lists.flat(); if (grid.isConnected) draw(); });
    }
    const ok = await dialog(board ? 'Foto de referencia' : 'Foto o archivo del mensaje', h('div', { class: 'fb-photo-pick' },
      field('Subir uno nuevo', upload, board ? 'JPG, PNG o WEBP.' : 'Foto (JPG, PNG o WEBP) o archivo: PDF, Word, Excel, audio o video, hasta 16 MB.'),
      h('p', { class: 'small muted' }, files.length || catalog.images.length ? 'O elige uno que ya tengas:' : 'Aún no tienes fotos ni archivos guardados.'),
      grid), 'Usar este');
    if (!ok || !chosen) return;
    if (chosen.kind === 'catalog') { d.image_id = chosen.id; d.attachment_id = ''; }
    else { d.attachment_id = chosen.id; if ('image_id' in d) d.image_id = ''; }
    if ('photo_hint' in d) d.photo_hint = '';
    commit({ inspector: true });
  }

  /* ---------- Vista de lista (teléfono y lectores de pantalla) ---------- */

  function renderOutline() {
    const placed = new Set();
    const groups = [];
    const walk = (startId) => {
      const out = [];
      for (let cur = byId(startId), guard = 0; cur && !placed.has(cur.id) && guard < 300; guard++) {
        placed.add(cur.id); out.push(cur);
        const e = edgeFrom(cur.id);
        cur = e ? byId(e.to) : null;
      }
      return out;
    };
    const t = S.board.nodes.find((n) => n.type === 'trigger');
    if (t) groups.push({ title: 'Línea principal', items: walk(t.id) });
    for (let gi = 0; gi < groups.length; gi++) {
      for (const n of groups[gi].items.filter((x) => x.type === 'message')) {
        for (const b of n.data.buttons.filter((x) => x.kind === 'reply')) {
          const e = edgeFrom(n.id, `b:${b.id}`);
          if (!e || placed.has(e.to) || ahead(n.id).has(e.to)) continue;
          groups.push({ title: `Si toca «${b.label || 'botón'}»`, items: walk(e.to) });
        }
      }
    }
    const loose = S.board.nodes.filter((n) => FLOW.has(n.type) && !placed.has(n.id));
    if (loose.length) groups.push({ title: 'Sin unir (no se publican)', items: loose });
    const extras = S.board.nodes.filter((n) => BOARD_ONLY.has(n.type));
    if (extras.length) groups.push({ title: 'Notas y fotos de la pizarra', items: extras });
    const item = (n) => {
      const errorProb = problemsFor(n.id).some((p) => !p.warning);
      return h('li', {}, h('button', { type: 'button', class: `fb-out-item${S.sel.has(n.id) ? ' is-sel' : ''}${errorProb ? ' has-problem' : ''}`, 'aria-current': S.sel.has(n.id) ? 'true' : null, onclick: () => pick([n.id], { focus: !isPhone() }) },
        h('span', { class: `fb-tile t-${n.type === 'text' || n.type === 'image' ? 'board' : n.type}`, 'aria-hidden': 'true' }, icon(iconOf(n), 16)),
        h('span', { class: 'fb-out-main' },
          h('span', { class: 'fb-out-title' }, kindLabel(n), errorProb ? h('span', { class: 'fb-out-alert' }, icon('alert', 14), h('span', { class: 'sr-only' }, 'Tiene pendientes')) : null),
          h('span', { class: 'fb-out-text' }, describe(n)),
          n.type === 'message' && n.data.buttons.length ? h('span', { class: 'fb-chips' }, n.data.buttons.map((b) => h('span', { class: 'fb-chip' }, b.label || 'botón', b.kind === 'reply' ? h('span', { class: 'muted' }, `→ ${buttonDest(n, b)}`) : null))) : null),
        icon('chevron-right', 16)));
    };
    const tail = t ? groups[0].items.at(-1) : null;
    fill(outline,
      groups.map((g) => h('section', { class: 'fb-out-group' }, h('h2', { class: 'fb-out-head' }, g.title), h('ol', { class: 'fb-out-list' }, g.items.map(item)))),
      canChain(tail) ? h('button', { type: 'button', class: 'fb-out-add', onclick: () => { S.sel.clear(); S.sel.add(tail.id); addFromPalette(SPECS.message); } }, icon('plus', 16), 'Agregar un mensaje al final') : null);
  }

  /* ---------- Refrescar ---------- */

  function refresh({ inspector: withInspector = false } = {}) {
    if (!canvas.hidden) renderNodes();
    else if (S.view === 'list') renderOutline();
    if (withInspector) renderInspector();
    updateStatus();
  }

  // Primer dibujo. Recién creado (desde una plantilla), el flujo se ordena con la altura real de cada elemento.
  const arrange = /[?&]ordenar=1/.test(location.hash);
  const fromAi = /[?&]ia=1/.test(location.hash);
  if (arrange || fromAi) history.replaceState(null, '', location.hash.replace(/\?.*$/, ''));
  if (arrange) fitted = true;
  setSave('saved');
  if (arrange) { setView('canvas'); tidy({ record: false }); if (S.view !== 'canvas' || isPhone()) setView(isPhone() ? 'list' : 'canvas'); }
  else setView(S.view);
  applyViewport();
  refreshProblems();
  renderInspector();
  if (fromAi) {
    let intro = null;
    try { intro = JSON.parse(sessionStorage.getItem(`fb-ai:${id}`) || 'null'); sessionStorage.removeItem(`fb-ai:${id}`); } catch { /* sin almacenamiento */ }
    openPanel('ai', intro ?? {});
  }
}
