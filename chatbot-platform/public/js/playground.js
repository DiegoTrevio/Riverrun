import { dataLabel } from './bot.js';
import { api, fill, h, run } from './core.js';
import { render } from './main.js';

const ACTION_LABEL = { paused: 'No respondió: el asistente no está activo en esta conversación', reply: 'Respondió', reply_with_image: 'Respondió con foto', handoff: 'Pasó la conversación a una persona', no_reply: 'No respondió', human: 'No respondió: la conversación está con una persona', inactive: 'No respondió: el asistente está apagado', error: 'Error' };

/** Traduce el motivo que se le dio a la IA a lenguaje para el dueño del negocio. */
function explainIssue(x) {
  const rules = [
    [/^Mencionaste datos que no están[^:]*: (.*?)\. Elimina.*$/s, (m) => `Quiso dar un dato que no está en tu información (${m[1]}). Se bloqueó.`],
    [/^No uses estas frases: (.*?)\.$/s, (m) => `Usó una frase prohibida (${m[1]}).`],
    [/^No hables de estos temas: (.*?)\. .*$/s, (m) => `Mencionó un tema prohibido (${m[1]}).`],
    [/^Trata al cliente de "usted".*$/s, () => 'Tuteó al cliente y está configurado "de usted".'],
    [/^Trata al cliente de "tú".*$/s, () => 'Habló de usted y está configurado "de tú".'],
    [/^La respuesta es demasiado larga.*$/s, () => 'La respuesta era más larga de lo configurado.'],
    [/^Un mensaje es demasiado largo.*$/s, () => 'Un mensaje era demasiado largo.'],
    [/^Dices que envías una imagen.*$/s, () => 'Prometió una foto que no está en tu catálogo.'],
    [/^Los IDs de imagen.*$/s, () => 'Quiso enviar una foto que no existe en tu catálogo.'],
    [/^El horario ".*" no está disponible.*$/s, () => 'Ofreció un horario que no está disponible en tu agenda.'],
    [/^El servicio ".*" no existe.*$/s, () => 'Quiso agendar un servicio que no existe.'],
    [/^Para agendar la llamada primero pide.*$/s, () => 'Quiso agendar una llamada sin tener el teléfono del cliente.'],
  ];
  for (const [re, fn] of rules) { const m = x.match(re); if (m) return fn(m); }
  return x;
}

/** Preguntas para comprobar que respeta la información y las reglas. */
const TEST_IDEAS = ['¿Cuánto cuesta?', '¿Qué horario tienen?', '¿Dónde están?', '¿Me haces un descuento?', '¿Tienen servicio a domicilio?', 'Quiero hablar con una persona'];

export async function tabPlayground(root, bot) {
  const session = localStorage.getItem('pg-session') || Math.random().toString(36).slice(2, 10);
  try { localStorage.setItem('pg-session', session); } catch { /* sin storage */ }
  const chat = h('div', { class: 'chat' });
  const savedData = h('div', {}, h('p', { class: 'small muted' }, 'Aquí aparecerán los datos que el cliente comparta.'));
  const debug = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Después de cada respuesta verás qué hizo el asistente, si alguna regla obligó a corregirla y qué datos del cliente guardó.'));
  const input = h('textarea', { placeholder: 'Escribe como si fueras el cliente…', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  const btn = h('button', { class: 'primary', onclick: () => send() }, 'Enviar');

  const bubble = (cls, content, img) =>
    h('div', { class: `bubble ${cls}` }, img ? h('img', { src: `/api/images/${img.id}/file` }) : null, img ? h('div', { class: 'small muted' }, `🖼 ${img.code}`) : null, content || null);

  const load = async () => {
    const d = await api('GET', `/api/chatbots/${bot.id}/playground/${session}`);
    fill(chat, ...d.messages.map((m) => bubble(m.sender === 'system' ? 'notify' : m.direction === 'in' ? 'in' : 'out', m.content, m.image_id ? { id: m.image_id, code: m.image_code } : null)));
    chat.scrollTop = chat.scrollHeight;
  };

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    chat.append(bubble('in', text));
    chat.scrollTop = chat.scrollHeight;
    btn.disabled = true;
    btn.textContent = 'Pensando…';
    const r = await run(() => api('POST', `/api/chatbots/${bot.id}/playground`, { session, text }));
    btn.disabled = false;
    btn.textContent = 'Enviar';
    if (!r) return;
    // Historial completo: incluye respuestas de reglas automáticas y notas del simulador.
    await load();
    for (const o of r.outputs.filter((x) => x.type === 'notify')) chat.append(bubble('notify', o.text));
    if (r.result.status === 'no_reply') chat.append(bubble('notify', '(la IA decidió no responder)'));
    if (r.result.status === 'human') chat.append(bubble('notify', '(conversación en modo humano: el bot no responde)'));
    if (r.result.status === 'paused') chat.append(bubble('notify', `(el asistente no responde: ${r.agent?.reason || 'en pausa'})`));
    if (r.result.status === 'error') chat.append(bubble('notify', `Error: ${r.result.error}`));
    chat.scrollTop = chat.scrollHeight;
    const c = r.contact || {};
    const attempts = r.result.attempts || [];
    const fixes = attempts.flatMap((a) => a.fixes);
    const rejected = attempts.filter((a) => a.retryable.length);
    const dataLabels = Object.fromEntries((bot.data_fields || []).map((f) => [f.key, f.label]));
    fill(savedData, c.name || Object.keys(c.data || {}).length
      ? h('ul', { class: 'small' }, c.name ? h('li', {}, 'Nombre: ', c.name) : null, Object.entries(c.data || {}).filter(([k]) => k !== 'nombre' && k !== 'name').map(([k, v]) => h('li', {}, `${dataLabels[k] || dataLabel(k)}: ${v}`)))
      : h('p', { class: 'small muted' }, 'Todavía no hay datos. Prueba a responder las preguntas del asistente.'));
    fill(debug,
      h('div', {}, h('strong', {}, 'Qué hizo: '), ACTION_LABEL[r.result.action] || ACTION_LABEL[r.result.status] || r.result.status,
        r.result.fallback_used ? h('div', { class: 'small' }, h('span', { class: 'badge orange' }, 'mensaje de respaldo'), ' La IA no logró una respuesta comprobable y se envió tu mensaje de respaldo.') : null,
        r.result.info_not_found ? h('div', { class: 'small' }, h('span', { class: 'badge orange' }, 'dato no encontrado'), ' Le preguntaron algo que no está en "Conocimiento". Agrégalo si quieres que lo responda.') : null),
      r.result.status === 'paused' ? null : h('div', {}, h('strong', {}, 'Revisión de reglas: '),
        !rejected.length && !fixes.length ? h('span', { class: 'badge green' }, '✓ cumplió todo a la primera') : null,
        rejected.length ? h('div', { class: 'small' }, h('span', { class: 'badge orange' }, `${rejected.length} ${rejected.length === 1 ? 'respuesta rehecha' : 'respuestas rehechas'}`), h('ul', { class: 'muted' }, [...new Set(rejected.flatMap((a) => a.retryable).map(explainIssue))].map((x) => h('li', {}, x)))) : null,
        fixes.length ? h('div', { class: 'small' }, h('span', { class: 'badge' }, 'ajustes automáticos'), h('ul', { class: 'muted' }, fixes.map((x) => h('li', {}, x)))) : null),
      h('div', {}, h('strong', {}, 'Conversación: '),
        r.conversation?.status === 'human' ? h('span', { class: 'badge orange' }, 'pasó con una persona (el asistente ya no responde)')
          : r.conversation?.status === 'closed' ? h('span', { class: 'badge' }, 'cerrada (si escribes de nuevo, empieza otra vez)')
          : r.agent && !r.agent.on ? h('span', {}, h('span', { class: 'badge orange' }, r.agent.state === 'waiting' ? 'esperando palabra de activación' : `asistente en pausa: ${r.agent.reason}`), ' ',
              h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/conversations/${r.conversation.id}/release`), 'Asistente reactivado')) chat.append(bubble('notify', '(asistente reactivado)')); } }, 'Reactivar asistente'))
          : h('span', { class: 'badge green' }, 'la atiende el asistente')),
      h('div', {}, h('strong', {}, 'Qué se activó: '),
        r.events?.length ? h('ul', { class: 'small' }, r.events.map((e) => h('li', { class: e.level === 'error' ? 'error' : '' }, e.message))) : h('span', { class: 'muted small' }, 'ninguna regla ni cambio')),
      c.notes?.length ? h('div', {}, h('strong', {}, 'Lo que recuerda: '), h('ul', { class: 'small' }, c.notes.map((n) => h('li', {}, n)))) : null,
      r.result.thinking ? h('details', { class: 'small' }, h('summary', {}, 'Por qué respondió así'), h('p', { class: 'muted' }, r.result.thinking)) : null,
      r.conversation?.summary ? h('details', { class: 'small' }, h('summary', {}, 'Resumen de memoria'), h('div', { class: 'pre muted' }, r.conversation.summary)) : null,
    );
  };

  const reset = async () => {
    await run(() => api('DELETE', `/api/chatbots/${bot.id}/playground/${session}`), 'Conversación reiniciada');
    const ns = Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('pg-session', ns); } catch { /* */ }
    render();
  };

  root.append(
    h('div', { class: 'split' },
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Simulador'), h('button', { class: 'small', onclick: reset }, 'Reiniciar conversación')),
        h('p', { class: 'muted small' }, 'Escribe como si fueras un cliente. Responde exactamente igual que en WhatsApp, con las mismas reglas (funciona aunque esté apagado). Las fotos se muestran aquí en lugar de enviarse.'),
        chat,
        h('div', { class: 'row', style: 'margin:8px 0;gap:6px;flex-wrap:wrap' }, h('span', { class: 'small muted' }, 'Prueba:'),
          TEST_IDEAS.map((q) => h('button', { class: 'small', onclick: () => { input.value = q; send(); } }, q))),
        h('div', { class: 'composer' }, input, btn)),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Datos guardados automáticamente'), savedData, h('details', {}, h('summary', {}, 'Detalles de la respuesta'), debug)),
    ),
  );
  load().catch(() => undefined);
  input.focus();
}
