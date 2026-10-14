import { needAccount } from './admin.js';
import { api, area, check, clone, confirmAction, field, fill, fmtDate, h, run, select, state, text, toast } from './core.js';
import { isAdmin, withAcct } from './session.js';

const KIND = { open: 'En curso', won: '✅ Ganada', lost: '❌ Perdida' };
const SOURCE = { inicio: 'entró', ia: 'la IA lo detectó', evento: 'por un evento', manual: 'a mano', cierre: 'al terminar la solicitud' };
/** Eventos que mueven una tarjeta a una columna (además de la situación que detecta la IA). */
const SIMPLE_EVENTS = [
  ['goal_completed', 'Se cumple el objetivo del agente'],
  ['appointment_booked', 'Agenda una cita'],
  ['appointment_cancelled', 'Cancela su cita'],
  ['handoff', 'Pasa con una persona'],
];

const timeAgo = (d) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(d)) / 60000));
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} días`;
};

/** #/pipeline[/<id>] tablero · #/pipeline/editar/<id|nuevo> editor. */
export async function viewPipeline(root, a, b) {
  if (needAccount(root)) return;
  if (a === 'editar') return editPipeline(root, b);
  const pipelines = await api('GET', withAcct('/api/pipelines'));
  if (!pipelines.length) {
    root.append(h('h1', {}, 'Pipeline'), h('div', { class: 'card' },
      h('p', {}, 'Un pipeline muestra en columnas en qué va cada cliente (por ejemplo Nuevo → Interesado → Cotizado → Ganado o Perdido). Cada solicitud es una tarjeta que pasa sola de una columna a otra según lo que pasa en la conversación: la IA detecta la situación que describes para cada columna, o un evento como cumplir el objetivo o agendar una cita. También puedes moverlas a mano.'),
      isAdmin() ? h('a', { class: 'btn primary', href: '#/pipeline/editar/nuevo' }, 'Crear mi pipeline') : h('p', { class: 'muted' }, 'Tu administrador aún no crea un pipeline.')));
    return;
  }
  const current = pipelines.find((p) => p.id === a) || pipelines[0];
  const opts = { days: 30 };
  const board = h('div', { class: 'pipeline-board', 'aria-busy': 'true' });
  const head = h('div', { class: 'row between' },
    h('h1', {}, 'Pipeline'),
    h('div', { class: 'row' },
      pipelines.length > 1 ? h('select', { 'aria-label': 'Pipeline', onchange: (e) => (location.hash = `#/pipeline/${e.target.value}`) }, pipelines.map((p) => h('option', { value: p.id, selected: p.id === current.id }, p.name))) : h('strong', {}, current.name),
      h('select', { 'aria-label': 'Ganadas y perdidas de los últimos', onchange: (e) => { opts.days = Number(e.target.value); load(); } }, [[7, '7 días'], [30, '30 días'], [90, '90 días'], [365, '1 año']].map(([v, l]) => h('option', { value: v, selected: v === opts.days }, `Cerradas: ${l}`))),
      isAdmin() ? h('a', { class: 'btn', href: `#/pipeline/editar/${current.id}` }, '⚙️ Configurar') : null,
      isAdmin() ? h('a', { class: 'btn', href: '#/pipeline/editar/nuevo' }, '+ Nuevo pipeline') : null));
  const note = current.chatbot_ids.length ? null : h('div', { class: 'banner warn' }, 'Ningún agente usa este pipeline todavía: las solicitudes no entrarán solas hasta que lo asignes a un agente en ', isAdmin() ? h('a', { href: `#/pipeline/editar/${current.id}` }, 'Configurar') : 'Configurar', '.');
  root.append(head, note, board);

  let data = null;
  let dragging = null;
  const move = async (card, stageId) => {
    if (!stageId || stageId === card.stage_id) return;
    await run(() => api('POST', `/api/pipeline-cards/${card.id}/move`, { stage_id: stageId }), 'Tarjeta movida');
    load();
  };
  const cardEl = (card) => h('article', { class: 'pipeline-card', draggable: 'true', ondragstart: (e) => { dragging = card; e.dataTransfer.setData('text/plain', String(card.id)); e.dataTransfer.effectAllowed = 'move'; }, ondragend: () => { dragging = null; } },
    h('a', { href: `#/conversation/${card.conversation_id}`, class: 'pipeline-card-title', draggable: 'false' }, card.contact_name || card.contact_phone || 'Cliente'),
    h('div', { class: 'small muted' }, [card.request_number > 1 ? `Solicitud ${card.request_number}.ª` : null, card.channel_name, card.assigned_name ? `👤 ${card.assigned_name}` : null, card.conversation_status === 'human' ? '🙋 con una persona' : null].filter(Boolean).join(' · ')),
    card.last_reason ? h('div', { class: 'small', title: card.last_reason }, `${card.last_source === 'ia' ? '🤖 ' : card.last_source === 'manual' ? '✋ ' : ''}${card.last_reason.length > 90 ? card.last_reason.slice(0, 90) + '…' : card.last_reason}`) : null,
    h('div', { class: 'row between small muted' }, h('span', {}, `En esta columna ${timeAgo(card.stage_entered_at)}`), card.closed_at ? h('span', { class: 'badge' }, 'Cerrada') : null),
    h('select', { class: 'small', 'aria-label': `Mover a ${card.contact_name || 'cliente'} a otra columna`, onchange: (e) => move(card, e.target.value) },
      h('option', { value: '' }, 'Mover a…'), data.pipeline.stages.filter((s) => s.id !== card.stage_id).map((s) => h('option', { value: s.id }, s.name))));
  const draw = () => {
    const byStage = new Map(data.pipeline.stages.map((s) => [s.id, []]));
    for (const c of data.cards) byStage.get(c.stage_id)?.push(c);
    fill(board, data.pipeline.stages.map((s) => {
      const cards = byStage.get(s.id);
      const col = h('section', { class: 'pipeline-col', 'aria-label': s.name, style: `--stage:${s.color}`,
        ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); },
        ondragleave: () => col.classList.remove('drop'),
        ondrop: (e) => { e.preventDefault(); col.classList.remove('drop'); const card = dragging; dragging = null; if (card) move(card, s.id); } },
      h('header', {}, h('strong', {}, s.name), ' ', h('span', { class: 'badge' }, cards.length), s.kind !== 'open' ? h('div', { class: 'small muted' }, KIND[s.kind]) : null),
      cards.length ? cards.map(cardEl) : h('p', { class: 'small muted' }, 'Sin tarjetas'));
      return col;
    }));
  };
  const load = async () => {
    data = await api('GET', `/api/pipelines/${current.id}/board?days=${opts.days}`);
    board.removeAttribute('aria-busy');
    draw();
  };
  await load();
}

async function editPipeline(root, id) {
  const isNew = id === 'nuevo';
  const [bots, pipelines] = await Promise.all([api('GET', withAcct('/api/chatbots')), api('GET', withAcct('/api/pipelines'))]);
  const p = isNew ? { ...(await api('GET', '/api/pipelines/template')), chatbot_ids: pipelines.length ? [] : bots.map((b) => b.id).slice(0, 1) } : clone(pipelines.find((x) => x.id === id) || {});
  if (!isNew && !p.id) { root.append(h('p', {}, 'Pipeline no encontrado')); return; }
  const usedBy = (botId) => pipelines.find((x) => x.id !== p.id && x.chatbot_ids.includes(botId));
  const stagesBox = h('div', { class: 'stack' });

  const stageEditor = (s, i) => {
    const has = (type) => s.events.some((e) => e.type === type);
    const toggle = (type, on) => { s.events = s.events.filter((e) => e.type !== type); if (on) s.events.push({ type }); };
    const dataEvent = s.events.find((e) => e.type === 'data_captured');
    const tagEvent = s.events.find((e) => e.type === 'tag_added');
    const extra = { field: dataEvent ? dataEvent.field || '*' : '', tag: tagEvent?.tag || '' };
    const syncExtra = () => {
      s.events = s.events.filter((e) => e.type !== 'data_captured' && e.type !== 'tag_added');
      if (extra.field.trim()) s.events.push({ type: 'data_captured', field: extra.field.trim() === '*' ? '' : extra.field.trim() });
      if (extra.tag.trim()) s.events.push({ type: 'tag_added', tag: extra.tag.trim() });
    };
    const moveStage = (d) => { const j = i + d; if (j < 0 || j >= p.stages.length) return; [p.stages[i], p.stages[j]] = [p.stages[j], p.stages[i]]; drawStages(); };
    return h('div', { class: 'card pipeline-stage-edit', style: `border-left:6px solid ${s.color}` },
      h('div', { class: 'row between' }, h('h3', {}, `${i + 1}. ${s.name || 'Columna'}`),
        h('div', { class: 'row' },
          h('button', { class: 'small', disabled: i === 0, onclick: () => moveStage(-1), 'aria-label': 'Subir columna' }, '↑'),
          h('button', { class: 'small', disabled: i === p.stages.length - 1, onclick: () => moveStage(1), 'aria-label': 'Bajar columna' }, '↓'),
          h('button', { class: 'small danger', disabled: p.stages.length <= 2, onclick: () => { p.stages.splice(i, 1); drawStages(); } }, 'Quitar'))),
      h('div', { class: 'row' },
        field('Nombre', text(s, 'name', { maxlength: 60 })),
        field('Tipo', select(s, 'kind', [['open', 'En curso'], ['won', 'Ganada (cierra bien)'], ['lost', 'Perdida (cierra mal)']])),
        field('Color', h('input', { type: 'color', value: s.color, oninput: (e) => (s.color = e.target.value) }))),
      i === 0
        ? h('p', { class: 'small muted' }, 'Aquí entra cada solicitud nueva.')
        : [
            field('¿Cuándo pasa a esta columna? (la IA lo detecta en la conversación)', area(s, 'when', { maxlength: 500, placeholder: 'Ej.: Ya se le dio al cliente un precio o una cotización de lo que quiere.' }),
              'Descríbelo con tus palabras. Déjalo vacío si solo debe moverse por los eventos de abajo o a mano.'),
            h('fieldset', { class: 'field' }, h('legend', {}, 'También pasa aquí cuando…'),
              SIMPLE_EVENTS.map(([type, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: has(type), onchange: (e) => toggle(type, e.target.checked) }), label)),
              h('div', { class: 'row' },
                field('Se captura el dato (clave, o * para cualquiera)', text(extra, 'field', { placeholder: 'ej. correo', oninput: syncExtra })),
                field('Se agrega la etiqueta', text(extra, 'tag', { placeholder: 'ej. vip', oninput: syncExtra })))),
          ]);
  };
  const drawStages = () => fill(stagesBox, p.stages.map(stageEditor), h('button', { onclick: () => { p.stages.push({ name: 'Nueva columna', kind: 'open', color: '#8b5cf6', when: '', events: [] }); drawStages(); } }, '+ Agregar columna'));
  drawStages();

  const save = async () => {
    const body = { name: p.name, stages: p.stages, chatbot_ids: p.chatbot_ids, allow_backward: !!p.allow_backward };
    const saved = await run(() => (isNew ? api('POST', '/api/pipelines', { ...body, account_id: state.accountId || undefined }) : api('PUT', `/api/pipelines/${p.id}`, body)), 'Pipeline guardado');
    if (saved?.id) location.hash = `#/pipeline/${saved.id}`;
  };
  root.append(
    h('a', { href: isNew ? '#/pipeline' : `#/pipeline/${p.id}` }, '← Tablero'),
    h('h1', {}, isNew ? 'Nuevo pipeline' : `Configurar «${p.name}»`),
    h('div', { class: 'card' },
      field('Nombre del pipeline', text(p, 'name', { maxlength: 80 })),
      h('fieldset', { class: 'field' }, h('legend', {}, 'Agentes que lo usan'),
        bots.length ? bots.map((b) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.chatbot_ids.includes(b.id), onchange: (e) => { p.chatbot_ids = e.target.checked ? [...p.chatbot_ids, b.id] : p.chatbot_ids.filter((x) => x !== b.id); } }),
          b.name, usedBy(b.id) ? h('span', { class: 'small muted' }, ` (ahora usa «${usedBy(b.id).name}»: se cambia a este)`) : null)) : h('p', { class: 'muted' }, 'Aún no tienes agentes.'),
        h('small', {}, 'Cada agente usa un solo pipeline. Las conversaciones de esos agentes entran solas en la primera columna.')),
      check(p, 'allow_backward', 'Permitir que una tarjeta regrese sola a una columna anterior'),
      h('p', { class: 'small muted' }, 'Las tarjetas avanzan solas; una vez en una columna de ganadas o perdidas ya no se mueven solas. A mano siempre puedes moverlas. Cuando el cliente vuelve por otra solicitud, la anterior se cierra (como ganada si cumplió el objetivo o perdida si no) y empieza una tarjeta nueva.')),
    h('h2', {}, 'Columnas'),
    stagesBox,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: save }, 'Guardar pipeline'),
      !isNew ? h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmAction(`¿Borrar el pipeline «${p.name}»? Se borran también sus tarjetas y su historial. Las conversaciones no se tocan.`))) return;
        if (await run(() => api('DELETE', `/api/pipelines/${p.id}`), 'Pipeline borrado')) location.hash = '#/pipeline';
      } }, 'Borrar pipeline') : null),
  );
  if (!bots.length) toast('Crea un agente para que las conversaciones entren al pipeline', true);
}

/** Tarjeta de la conversación: en qué columna va su solicitud y por qué se movió. */
export function pipelineCard(cards = []) {
  if (!cards.length) return null;
  const [cur, ...older] = cards;
  const name = (card, id) => card.stages.find((s) => s.id === id)?.name || id;
  const stage = cur.stages.find((s) => s.id === cur.stage_id);
  return h('details', { class: 'small', open: true },
    h('summary', {}, `Pipeline «${cur.pipeline_name}»: `, h('strong', { style: stage ? `color:${stage.color}` : '' }, name(cur, cur.stage_id)), cur.closed_at ? ' (cerrada)' : ''),
    h('ul', { style: 'margin:6px 0;padding-left:18px' }, [...cur.moves].reverse().map((m) => h('li', {},
      `${fmtDate(m.created_at)} · ${m.from_stage ? `${name(cur, m.from_stage)} → ` : ''}${name(cur, m.to_stage)} · ${SOURCE[m.source] || m.source}${m.user_name ? ` (${m.user_name})` : ''}`,
      m.reason && m.source !== 'inicio' ? h('div', { class: 'muted' }, m.reason) : null))),
    older.length ? h('div', { class: 'muted' }, `Solicitudes anteriores: ${older.map((c) => `${c.request_number}.ª ${name(c, c.stage_id)}`).join(' · ')}`) : null,
    h('a', { href: `#/pipeline/${cur.pipeline_id}` }, 'Ver tablero →'));
}
