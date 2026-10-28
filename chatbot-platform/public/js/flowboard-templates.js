/**
 * Plantillas del lienzo de flujos y la miniatura de un dibujo. Las plantillas traen posiciones aproximadas: el editor
 * las ordena al abrirlas por primera vez, ya con la altura real de cada elemento.
 */

/** Identificador corto de un elemento del lienzo (letras, números, guion y guion bajo). */
export const newId = (prefix = 'n') => `${prefix}${Math.random().toString(36).slice(2, 9)}`;

const node = (id, type, x, y, data = {}) => ({ id, type, x, y, data });
const edge = (from, port, to) => ({ id: `e_${from}_${port.replace(':', '_')}_${to}`, from, port, to });
const btn = (id, label, extra = {}) => ({ id, label, kind: 'reply', url: '', reply: '', ...extra });

export const TEMPLATES = [
  {
    key: 'bienvenida',
    name: 'Bienvenida con menú',
    description: 'Saluda a cada cliente nuevo y le ofrece tres opciones con botones.',
    build: () => ({
      layout: true,
      nodes: [
        node('t1', 'trigger', 0, 0, { trigger: { type: 'new_contact' }, stop_ai: false }),
        node('m1', 'message', 0, 200, { text: '¡Hola {{nombre}}! Gracias por escribirnos. ¿En qué te ayudamos?', wait_for_choice: true, buttons: [btn('b1', 'Ver servicios'), btn('b2', 'Hacer una cita'), btn('b3', 'Hablar con alguien')] }),
        node('m2', 'message', 380, 200, { text: 'Estos son nuestros servicios: …\n\n¿Quieres que te aparte un lugar?' }),
        node('m3', 'message', 760, 200, { text: 'Con gusto. ¿Qué día y a qué hora te queda mejor?' }),
        node('a1', 'action', 1140, 200, { action: 'handoff' }),
        node('n1', 'note', -320, 0, { text: 'Cambia el texto de servicios por los tuyos. El agente contesta lo demás.', color: 'sun' }),
      ],
      edges: [edge('t1', 'out', 'm1'), edge('m1', 'b:b1', 'm2'), edge('m1', 'b:b2', 'm3'), edge('m1', 'b:b3', 'a1')],
    }),
  },
  {
    key: 'promocion',
    name: 'Promoción con foto',
    description: 'Cuando escriben una palabra, envía la promo con su foto y dos caminos.',
    build: () => ({
      layout: true,
      nodes: [
        node('t1', 'trigger', 0, 0, { trigger: { type: 'message_received', match: 'keywords', keywords: ['promo', 'promoción'] }, stop_ai: true }),
        node('a0', 'action', 0, 180, { action: 'tag', tag: 'promo' }),
        node('m1', 'message', 0, 320, { text: '{{nombre}}, esta semana tenemos 2×1 en todos nuestros servicios. ¿Te interesa?', buttons: [btn('b1', 'Quiero apartar'), btn('b2', 'Ver precios')] }),
        node('w1', 'wait', 0, 620, { value: 1, unit: 'days', at_time: '10:00' }),
        node('m2', 'message', 0, 760, { text: '¿Pudiste ver la promo? Termina este domingo.' }),
        node('a1', 'action', 380, 320, { action: 'handoff' }),
        node('m3', 'message', 760, 320, { text: 'Precios con la promo: …' }),
        node('n1', 'note', -320, 320, { text: 'Agrega la foto de la promo en el mensaje (Foto → Subir).', color: 'sky' }),
      ],
      edges: [edge('t1', 'out', 'a0'), edge('a0', 'out', 'm1'), edge('m1', 'out', 'w1'), edge('w1', 'out', 'm2'), edge('m1', 'b:b1', 'a1'), edge('m1', 'b:b2', 'm3')],
    }),
  },
  {
    key: 'seguimiento',
    name: 'Seguimiento de 3 días',
    description: 'Tres mensajes: hoy, mañana y en tres días. Se detiene si el cliente responde.',
    build: () => ({
      layout: true,
      nodes: [
        node('t1', 'trigger', 0, 0, { trigger: null }),
        node('m1', 'message', 0, 180, { text: 'Hola {{nombre}}, ¿pudiste revisar la información que te enviamos?' }),
        node('w1', 'wait', 0, 380, { value: 1, unit: 'days', at_time: '10:00' }),
        node('m2', 'message', 0, 520, { text: 'Te escribo de nuevo por si tienes alguna duda. Aquí estamos para ayudarte.' }),
        node('w2', 'wait', 0, 720, { value: 2, unit: 'days', at_time: '10:00' }),
        node('m3', 'message', 0, 860, { text: 'Último recordatorio: ¿te apartamos un lugar esta semana?', buttons: [btn('b1', 'Sí, apártalo'), btn('b2', 'Ahora no')] }),
        node('a1', 'action', 380, 860, { action: 'handoff' }),
        node('a2', 'action', 760, 860, { action: 'tag', tag: 'no_interesado' }),
      ],
      edges: [edge('t1', 'out', 'm1'), edge('m1', 'out', 'w1'), edge('w1', 'out', 'm2'), edge('m2', 'out', 'w2'), edge('w2', 'out', 'm3'), edge('m3', 'b:b1', 'a1'), edge('m3', 'b:b2', 'a2')],
    }),
  },
  {
    key: 'encuesta',
    name: 'Encuesta de satisfacción',
    description: 'Al cumplirse el objetivo, pregunta cómo le fue y avisa si algo salió mal.',
    build: () => ({
      layout: true,
      nodes: [
        node('t1', 'trigger', 0, 0, { trigger: { type: 'goal_completed' }, stop_ai: false }),
        node('w1', 'wait', 0, 180, { value: 2, unit: 'hours' }),
        node('m1', 'message', 0, 320, { text: '{{nombre}}, ¿cómo calificas la atención que recibiste?', buttons: [btn('b1', 'Excelente', { reply: '¡Gracias! Nos alegra mucho.' }), btn('b2', 'Regular', { reply: 'Gracias por decirnos. Vamos a mejorar.' }), btn('b3', 'Mala')] }),
        node('a1', 'action', 380, 320, { action: 'tag', tag: 'satisfecho' }),
        node('a2', 'action', 760, 320, { action: 'tag', tag: 'regular' }),
        node('a3', 'action', 1140, 320, { action: 'handoff', reason: 'Calificó mal la atención' }),
      ],
      edges: [edge('t1', 'out', 'w1'), edge('w1', 'out', 'm1'), edge('m1', 'b:b1', 'a1'), edge('m1', 'b:b2', 'a2'), edge('m1', 'b:b3', 'a3')],
    }),
  },
];

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/**
 * Miniatura del dibujo: cada elemento como un bloque de su tono y las líneas que los unen. Acepta el lienzo completo o
 * la forma compacta del listado ({ nodes: [[x, y, tipo]], edges: [[i, j]] }).
 */
export function boardThumb(board, width = 96, height = 64) {
  const compact = Array.isArray(board?.nodes?.[0]);
  const nodes = (board?.nodes ?? []).map((n) => (compact ? { x: n[0], y: n[1], type: n[2] } : n));
  const edges = (board?.edges ?? []).map((e) => (compact ? e : [board.nodes.findIndex((n) => n.id === e.from), board.nodes.findIndex((n) => n.id === e.to)])).filter(([a, b]) => a >= 0 && b >= 0);
  const box = svg('svg', { class: 'fb-thumb', viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', focusable: 'false' });
  if (!nodes.length) return box;
  const W = 288, H = 150;
  const minX = Math.min(...nodes.map((n) => n.x)), maxX = Math.max(...nodes.map((n) => n.x + W));
  const minY = Math.min(...nodes.map((n) => n.y)), maxY = Math.max(...nodes.map((n) => n.y + H));
  const pad = 6;
  const s = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY));
  const ox = pad + ((width - pad * 2) - (maxX - minX) * s) / 2, oy = pad + ((height - pad * 2) - (maxY - minY) * s) / 2;
  const at = (n) => ({ x: ox + (n.x - minX) * s, y: oy + (n.y - minY) * s, w: W * s, h: H * s });
  for (const [a, b] of edges) {
    const p = at(nodes[a]), q = at(nodes[b]);
    box.append(svg('path', { class: 'fb-thumb-line', d: `M${p.x + p.w / 2} ${p.y + p.h}V${(p.y + p.h + q.y) / 2}H${q.x + q.w / 2}V${q.y}` }));
  }
  for (const n of nodes) {
    const r = at(n);
    const short = n.type === 'trigger' || n.type === 'wait' || n.type === 'action';
    box.append(svg('rect', { class: `fb-thumb-node t-${n.type}`, x: r.x, y: r.y, width: Math.max(r.w, 3), height: Math.max(r.h * (short ? 0.5 : 1), 2), rx: 1.5 }));
  }
  return box;
}
