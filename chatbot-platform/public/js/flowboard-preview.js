import { fill, h, state } from './core.js';
import { icon } from './icons.js';

/*
 * Vista previa del lienzo: recorre el flujo como lo vería el cliente en WhatsApp. Sigue las mismas reglas que al
 * publicar: un botón unido a lo que sigue en la línea lo envía ya, uno unido a otro mensaje empieza esa rama, y uno sin
 * línea termina el flujo. Las variables se llenan con un cliente de ejemplo.
 */

const SAMPLE = () => ({
  nombre: 'Ana', nombre_completo: 'Ana López', cliente: 'Ana', telefono: '+52 55 1234 5678',
  negocio: state.me?.account?.name || 'tu negocio', canal: 'WhatsApp', asesor: 'Luis',
  fecha_hoy: new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long' }),
});
const UNIT_WORD = { minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'] };
const STARTED = { intent: 'La IA detecta la intención', tag_added: 'Se le pone la etiqueta', no_reply: 'El cliente dejó de responder', appointment_booked: 'Agendó una cita', goal_completed: 'Se cumplió el objetivo', data_captured: 'Se guardó un dato', handoff: 'Pasó con una persona' };

export function previewPanel({ board, files, fileUrl, onShow }) {
  const nodes = new Map(board.nodes.map((n) => [n.id, n]));
  const next = (id, port = 'out') => { const e = board.edges.find((x) => x.from === id && x.port === port); return e ? nodes.get(e.to) : null; };
  const chat = h('div', { class: 'fb-chat', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversación de ejemplo' });
  const time = () => new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  let firstWords = 'Hola';
  let steps = 0;
  const vars = (t) => {
    const v = { ...SAMPLE(), mensaje: firstWords };
    return String(t).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (all, k) => v[k] ?? (k.startsWith('campo.') || k.startsWith('dato.') ? '…' : all));
  };
  const scroll = () => requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  const note = (text, iconName = 'clock') => { chat.append(h('div', { class: 'fb-chat-note' }, icon(iconName, 14), h('span', {}, text))); scroll(); };
  const customer = (text) => { chat.append(h('div', { class: 'fb-bubble in' }, h('span', {}, text), h('time', {}, time()))); scroll(); };
  const disableChoices = () => chat.querySelectorAll('.fb-choice').forEach((b) => { b.disabled = true; });

  function photo(d) {
    if (d.image_id) return h('img', { src: `/api/images/${d.image_id}/file`, alt: '' });
    const f = files.find((x) => x.id === d.attachment_id);
    if (!f) return null;
    if (f.kind !== 'image') return h('div', { class: 'fb-bubble-file' }, icon('paperclip', 16), h('span', {}, f.name));
    const img = h('img', { alt: '' });
    fileUrl(f).then((u) => { if (u) img.src = u; });
    return img;
  }

  function action(n, label) {
    const d = n.data;
    if (d.action === 'tag') note(`Se le pone la etiqueta «${d.tag || 'sin nombre'}»`, 'tag');
    else if (d.action === 'handoff') note('Pasa con una persona de tu equipo: el agente deja de contestar', 'user');
    else if (d.action === 'alert') note('Tu equipo recibe un aviso', 'bell');
    else if (d.action === 'flow') note('Empieza otro de tus flujos', 'branch');
    else note(label ? `Tocó «${label}»: fin del flujo` : 'Fin del flujo', 'flag');
  }

  /** Recorre la línea desde `node`: esperas y mensajes; al llegar a botones, espera la elección. */
  function run(node) {
    for (let cur = node; cur;) {
      if (++steps > 200) { note('El recorrido se detuvo aquí: revisa que la línea no dé vueltas.', 'alert'); return; }
      if (cur.type === 'wait') {
        const d = cur.data;
        note(`${d.value === 0 ? 'Enseguida' : `${d.value} ${UNIT_WORD[d.unit][d.value === 1 ? 0 : 1]} después`}${d.at_time ? `, a las ${d.at_time}` : ''}`);
        cur = next(cur.id);
        continue;
      }
      if (cur.type === 'action') { action(cur, null); return; }
      if (cur.type !== 'message') break;
      const d = cur.data;
      const replies = d.buttons.filter((b) => b.kind === 'reply' && b.label.trim());
      const links = d.buttons.filter((b) => b.kind === 'url' && b.label.trim());
      const pic = photo(d);
      const id = cur.id;
      chat.append(h('div', { class: 'fb-bubble out', role: 'button', tabindex: '0', title: 'Ver en el lienzo', onclick: () => onShow?.(id), onkeydown: (e) => { if (e.key === 'Enter') onShow?.(id); } },
        pic ? h('div', { class: 'fb-bubble-media' }, pic) : null,
        d.text.trim() ? h('span', {}, vars(d.text)) : null,
        h('time', {}, time()),
        links.length ? h('div', { class: 'fb-bubble-links' }, links.map((b) => h('span', {}, icon('external', 14), b.label))) : null));
      const after = next(cur.id);
      if (replies.length) {
        const message = cur;
        const choices = h('div', { class: 'fb-choices', role: 'group', 'aria-label': 'Botones del mensaje' },
          replies.map((b) => h('button', { type: 'button', class: 'fb-choice', onclick: () => { disableChoices(); tap(message, b); } }, b.label)));
        if (after && !(d.wait_for_choice && d.if_no_choice === 'end')) choices.append(h('button', { type: 'button', class: 'fb-choice skip', onclick: () => { disableChoices(); note('No eligió ningún botón'); run(after); } }, 'No elegir y seguir'));
        else if (after) choices.append(h('button', { type: 'button', class: 'fb-choice skip', onclick: () => { disableChoices(); note('No eligió a tiempo: el flujo termina', 'flag'); } }, 'No elegir'));
        chat.append(choices);
        scroll();
        return;
      }
      cur = after;
    }
    note('Fin del flujo', 'flag');
  }

  function tap(message, b) {
    customer(b.label);
    if (b.reply.trim()) { chat.append(h('div', { class: 'fb-bubble out' }, h('span', {}, vars(b.reply)), h('time', {}, time()))); scroll(); }
    const target = next(message.id, `b:${b.id}`);
    if (!target) { note(`Tocó «${b.label}»: fin del flujo`, 'flag'); return; }
    // Unido a lo que sigue en la misma línea: sale ya, sin la espera.
    const ahead = [];
    for (let c = next(message.id), guard = 0; c && guard < 50; c = next(c.id), guard++) { ahead.push(c); if (c.type !== 'wait') break; }
    if (ahead.some((c) => c.id === target.id)) { run(ahead.find((c) => c.type !== 'wait') ?? null); return; }
    if (target.type === 'action') {
      action(target, b.label);
      const later = next(message.id);
      if (target.data.action === 'tag' && later) chat.append(h('div', { class: 'fb-choices' }, h('button', { type: 'button', class: 'fb-choice skip', onclick: (e) => { e.currentTarget.disabled = true; run(later); } }, 'Ver lo que sigue')));
      return;
    }
    run(target);
  }

  function start() {
    fill(chat);
    steps = 0;
    const t = board.nodes.find((n) => n.type === 'trigger');
    if (!t) { note('Agrega el inicio para ver la vista previa.', 'alert'); return; }
    const tr = t.data.trigger;
    firstWords = tr?.type === 'message_received' && tr.match !== 'any' && tr.keywords.length ? tr.keywords[0] : '¡Hola! Buenas tardes';
    if (!tr) note('Lo envías tú desde una conversación o a un grupo', 'send');
    else if (tr.type === 'message_received' || tr.type === 'new_contact') customer(firstWords);
    else note(STARTED[tr.type] ?? 'Empieza el flujo', 'zap');
    let cur = next(t.id);
    for (let guard = 0; cur?.type === 'action' && guard < 20; guard++) {
      action(cur, null);
      if (cur.data.action !== 'tag' && cur.data.action !== 'alert') return;
      cur = next(cur.id);
    }
    if (!cur) { note('El inicio aún no lleva a ningún mensaje', 'alert'); return; }
    run(cur);
  }

  const name = state.me?.account?.name || 'Tu negocio';
  const phone = h('div', { class: 'fb-phone' },
    h('div', { class: 'fb-phone-bar' },
      h('span', { class: 'fb-phone-avatar', 'aria-hidden': 'true' }, name.trim()[0]?.toUpperCase() || 'N'),
      h('span', { class: 'fb-phone-who' }, h('strong', {}, name), h('span', { class: 'small' }, 'en línea'))),
    chat);
  start();
  return h('div', { class: 'fb-preview' },
    h('p', { class: 'help' }, 'Así lo vive tu cliente. Toca los botones para recorrer cada rama; toca un mensaje para verlo en el lienzo.'),
    phone,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'small', onclick: start }, icon('undo', 14), 'Empezar de nuevo')),
    h('p', { class: 'small muted' }, 'En el ejemplo, {{nombre}} es Ana. En WhatsApp con QR los botones salen numerados y el cliente contesta con el número.'));
}
