import { needAccount } from './admin.js';
import { api, area, check, clone, confirmAction, field, fill, fmtDate, fmtPhone, h, run, select, state, text, toast } from './core.js';
import { icon } from './icons.js';
import { isAdmin, withAcct } from './session.js';

const KIND = { open: 'En curso', won: 'Ganada', lost: 'Perdida' };
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

/** Valor en la moneda del pipeline (sin decimales si son cero). */
const money = (n, currency) => {
  const digits = Number(n) % 1 ? 2 : 0;
  try { return new Intl.NumberFormat('es-MX', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(n) || 0); }
  catch { return `${Number(n) || 0} ${currency}`; }
};
const initialsOf = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

/** #/pipeline[/<id>] tablero · #/pipeline/editar/<id|nuevo> editor. Como «Oportunidades» de Go High Level. */
export async function viewPipeline(root, a, b) {
  if (needAccount(root)) return;
  if (a === 'editar') return editPipeline(root, b);
  const pipelines = await api('GET', withAcct('/api/pipelines'));
  if (!pipelines.length) {
    root.append(h('h1', {}, 'Oportunidades'), h('div', { class: 'card' },
      h('p', {}, 'Un pipeline muestra en columnas en qué va cada cliente (Nuevo → Interesado → Cotizado → Ganado o Perdido). Cada oportunidad avanza sola según la conversación; también puedes moverla a mano y ponerle un valor.'),
      isAdmin() ? h('a', { class: 'btn primary', href: '#/pipeline/editar/nuevo' }, 'Crear mi pipeline') : h('p', { class: 'muted' }, 'Tu administrador aún no crea un pipeline.')));
    return;
  }
  const current = pipelines.find((p) => p.id === a) || pipelines[0];
  const pref = (() => { try { return localStorage.getItem('cp-opps-view') || 'board'; } catch { return 'board'; } })();
  const opts = { days: 30, q: '', user: '', view: pref };
  const results = h('div', { 'aria-busy': 'true' });
  const totals = h('div', { class: 'opp-totals small muted', role: 'status' });
  const head = h('div', { class: 'row between opp-head' },
    h('div', {}, h('h1', { style: 'margin:0' }, 'Oportunidades'), totals),
    h('div', { class: 'row' },
      isAdmin() ? h('a', { class: 'btn', href: `#/pipeline/editar/${current.id}` }, 'Configurar') : null,
      isAdmin() ? h('a', { class: 'btn primary', href: '#/pipeline/editar/nuevo' }, '+ Nuevo pipeline') : null));
  const setView = (k) => {
    opts.view = k;
    try { localStorage.setItem('cp-opps-view', k); } catch { /* sin almacenamiento */ }
    viewGroup.querySelectorAll('button').forEach((x) => { const on = x.dataset.view === k; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    draw();
  };
  const viewGroup = h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Vista' },
    [['board', 'Tablero'], ['list', 'Lista']].map(([k, l]) => h('button', { 'data-view': k, class: opts.view === k ? 'active' : '', 'aria-pressed': String(opts.view === k), onclick: () => setView(k) }, l)));
  const userSelect = h('select', { 'aria-label': 'Persona', onchange: (e) => { opts.user = e.target.value; draw(); } }, h('option', { value: '' }, 'Todo el equipo'));
  const toolbar = h('div', { class: 'card opp-toolbar' },
    h('div', { class: 'row' },
      pipelines.length > 1
        ? h('select', { 'aria-label': 'Pipeline', onchange: (e) => (location.hash = `#/pipeline/${e.target.value}`) }, pipelines.map((p) => h('option', { value: p.id, selected: p.id === current.id }, p.name)))
        : h('strong', {}, current.name),
      h('input', { type: 'search', class: 'opp-search', placeholder: 'Buscar por nombre o teléfono', 'aria-label': 'Buscar oportunidades', oninput: (e) => { opts.q = e.target.value.trim().toLowerCase(); draw(); } }),
      userSelect,
      h('select', { 'aria-label': 'Cerradas de los últimos', onchange: (e) => { opts.days = Number(e.target.value); load(); } }, [[7, '7 días'], [30, '30 días'], [90, '90 días'], [365, '1 año']].map(([v, l]) => h('option', { value: v, selected: v === opts.days }, `Cerradas: ${l}`)))),
    viewGroup);
  const note = current.chatbot_ids.length ? null : h('div', { class: 'banner warn' }, 'Ningún agente usa este pipeline todavía: las solicitudes no entrarán solas hasta que lo asignes a un agente en ', isAdmin() ? h('a', { href: `#/pipeline/editar/${current.id}` }, 'Configurar') : 'Configurar', '.');
  root.append(head, note, toolbar, results);

  let data = null;
  let dragging = null;
  const cur = () => data.pipeline.currency || 'MXN';
  const stageOf = (id) => data.pipeline.stages.find((s) => s.id === id);
  const sum = (list) => list.reduce((n, c) => n + Number(c.value || 0), 0);
  const move = async (card, stageId) => {
    if (!stageId || stageId === card.stage_id) return;
    await run(() => api('POST', `/api/pipeline-cards/${card.id}/move`, { stage_id: stageId }), 'Oportunidad movida');
    load();
  };
  const visible = () => data.cards.filter((c) => (!opts.user || (opts.user === 'none' ? !c.assigned_user_id : c.assigned_user_id === opts.user))
    && (!opts.q || `${c.contact_name} ${c.contact_phone}`.toLowerCase().includes(opts.q)));
  const avatar = (c) => c.assigned_name ? h('span', { class: 'mini-avatar', title: `Atiende: ${c.assigned_name}`, 'aria-hidden': 'true' }, initialsOf(c.assigned_name)) : null;
  const cardEl = (card) => h('article', { class: 'pipeline-card', draggable: 'true', tabindex: '0', role: 'button',
    'aria-label': `${card.contact_name || 'Cliente'}, ${money(card.value, cur())}${card.assigned_name ? `, atiende ${card.assigned_name}` : ''}`,
    ondragstart: (e) => { dragging = card; e.dataTransfer.setData('text/plain', String(card.id)); e.dataTransfer.effectAllowed = 'move'; }, ondragend: () => { dragging = null; },
    onclick: () => openOpportunity(card), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOpportunity(card); } } },
    h('div', { class: 'row between' }, h('strong', { class: 'pipeline-card-title' }, card.contact_name || card.contact_phone || 'Cliente'), avatar(card)),
    h('div', { class: 'opp-value' }, money(card.value, cur())),
    h('div', { class: 'small muted' }, [card.channel_name, card.request_number > 1 ? `Solicitud ${card.request_number}.ª` : null, card.conversation_status === 'human' ? 'con una persona' : null].filter(Boolean).join(' · ')),
    card.last_reason ? h('div', { class: 'small opp-reason', title: card.last_reason }, `${card.last_source === 'ia' ? 'IA: ' : card.last_source === 'manual' ? 'A mano: ' : ''}${card.last_reason}`) : null,
    h('div', { class: 'row between small muted' }, h('span', {}, timeAgo(card.stage_entered_at)), card.closed_at ? h('span', { class: 'badge' }, 'Cerrada') : null));
  const draw = () => {
    const cards = visible();
    const open = cards.filter((c) => stageOf(c.stage_id)?.kind === 'open');
    fill(totals, `${cards.length} ${cards.length === 1 ? 'oportunidad' : 'oportunidades'} · ${money(sum(cards), cur())} en total · ${money(sum(open), cur())} en curso`);
    if (opts.view === 'list') {
      fill(results, h('div', { class: 'card', style: 'padding:0' }, cards.length ? h('table', {},
        h('thead', {}, h('tr', {}, ['Oportunidad', 'Columna', 'Valor', 'Atiende', 'Canal', 'En la columna'].map((t) => h('th', {}, t)))),
        h('tbody', {}, cards.map((c) => {
          const st = stageOf(c.stage_id);
          return h('tr', { class: 'click', onclick: () => openOpportunity(c) },
            h('td', {}, h('strong', {}, c.contact_name || c.contact_phone || 'Cliente'), h('div', { class: 'small muted' }, c.contact_phone ? fmtPhone(c.contact_phone) : '')),
            h('td', {}, h('span', { class: 'stage-pill', style: `--stage:${st?.color || '#667085'}` }, st?.name || c.stage_id)),
            h('td', {}, money(c.value, cur())),
            h('td', {}, c.assigned_name || h('span', { class: 'muted' }, 'Sin asignar')),
            h('td', {}, c.channel_name),
            h('td', {}, timeAgo(c.stage_entered_at)));
        }))) : h('p', { class: 'muted', style: 'padding:16px' }, 'No hay oportunidades con estos filtros.')));
      return;
    }
    const byStage = new Map(data.pipeline.stages.map((s) => [s.id, []]));
    for (const c of cards) byStage.get(c.stage_id)?.push(c);
    fill(results, h('div', { class: 'pipeline-board' }, data.pipeline.stages.map((s) => {
      const list = byStage.get(s.id);
      const col = h('section', { class: 'pipeline-col', 'aria-label': s.name, style: `--stage:${s.color}`,
        ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); },
        ondragleave: () => col.classList.remove('drop'),
        ondrop: (e) => { e.preventDefault(); col.classList.remove('drop'); const card = dragging; dragging = null; if (card) move(card, s.id); } },
      h('header', {},
        h('div', { class: 'row between' }, h('strong', {}, s.name), h('span', { class: 'badge' }, list.length)),
        h('div', { class: 'small muted' }, money(sum(list), cur()), s.kind !== 'open' ? ` · ${KIND[s.kind]}` : '')),
      h('div', { class: 'pipeline-col-cards' }, list.length ? list.map(cardEl) : h('p', { class: 'small muted' }, 'Sin oportunidades')));
      return col;
    })));
  };
  const load = async () => {
    data = await api('GET', `/api/pipelines/${current.id}/board?days=${opts.days}`);
    results.removeAttribute('aria-busy');
    // Personas que aparecen en el tablero (para el filtro).
    const people = new Map(data.cards.filter((c) => c.assigned_user_id).map((c) => [c.assigned_user_id, c.assigned_name || 'Persona del equipo']));
    fill(userSelect, h('option', { value: '' }, 'Todo el equipo'), [...people].map(([id, n]) => h('option', { value: id, selected: id === opts.user }, n)), h('option', { value: 'none', selected: opts.user === 'none' }, 'Sin asignar'));
    draw();
  };

  /** Ficha de la oportunidad (como en GHL): valor, columna, quién atiende y su historial. */
  async function openOpportunity(card) {
    const previous = document.activeElement;
    const box = h('dialog', { class: 'card app-dialog appt-panel', 'aria-label': `Oportunidad de ${card.contact_name || 'cliente'}` });
    const close = () => { box.close(); box.remove(); if (previous?.isConnected) previous.focus(); };
    box.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    const v = { value: Number(card.value) || 0, stage: card.stage_id };
    const history = h('div', { class: 'small muted' }, 'Cargando historial…');
    box.append(
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, card.contact_name || card.contact_phone || 'Cliente'), h('button', { class: 'icon-only', 'aria-label': 'Cerrar', onclick: close }, icon('x'))),
      h('dl', { class: 'appt-facts' },
        h('dt', {}, 'Teléfono'), h('dd', {}, card.contact_phone ? fmtPhone(card.contact_phone) : '—'),
        h('dt', {}, 'Atiende'), h('dd', {}, card.assigned_name || 'Sin asignar'),
        h('dt', {}, 'Canal'), h('dd', {}, card.channel_name || '—')),
      h('div', { class: 'grid', style: 'gap:12px' },
        field(`Valor (${cur()})`, h('input', { type: 'number', min: 0, step: '0.01', value: v.value, oninput: (e) => (v.value = Number(e.target.value) || 0) })),
        field('Columna', select(v, 'stage', data.pipeline.stages.map((s) => [s.id, s.name])))),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          if (v.value !== Number(card.value) && !(await run(() => api('PATCH', `/api/pipeline-cards/${card.id}`, { value: v.value })))) return;
          if (v.stage !== card.stage_id && !(await run(() => api('POST', `/api/pipeline-cards/${card.id}/move`, { stage_id: v.stage })))) return;
          toast('Oportunidad guardada'); close(); load();
        } }, 'Guardar'),
        h('a', { class: 'btn', href: `#/conversation/${card.conversation_id}`, onclick: close }, 'Abrir chat')),
      h('h3', {}, 'Historial'), history);
    document.body.append(box);
    box.showModal();
    try {
      const cards = await api('GET', `/api/conversations/${card.conversation_id}/pipeline`);
      const mine = cards.find((c) => String(c.id) === String(card.id));
      fill(history, mine ? pipelineCard([mine]) : 'Sin movimientos.');
    } catch { fill(history, 'No se pudo cargar el historial.'); }
  }

  await load();
}

async function editPipeline(root, id) {
  const isNew = id === 'nuevo';
  const [bots, pipelines] = await Promise.all([api('GET', withAcct('/api/chatbots')), api('GET', withAcct('/api/pipelines'))]);
  const p = isNew ? { currency: 'MXN', ...(await api('GET', '/api/pipelines/template')), chatbot_ids: pipelines.length ? [] : bots.map((b) => b.id).slice(0, 1) } : clone(pipelines.find((x) => x.id === id) || {});
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
  const drawStages = () => fill(stagesBox, p.stages.map(stageEditor), h('button', { onclick: () => { p.stages.push({ name: 'Nueva columna', kind: 'open', color: '#64748b', when: '', events: [] }); drawStages(); } }, '+ Agregar columna'));
  drawStages();

  const save = async () => {
    const body = { name: p.name, stages: p.stages, chatbot_ids: p.chatbot_ids, allow_backward: !!p.allow_backward, currency: p.currency || 'MXN' };
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
      field('Moneda del valor de las oportunidades', select(p, 'currency', [['MXN', 'Pesos mexicanos (MXN)'], ['USD', 'Dólares (USD)'], ['EUR', 'Euros (EUR)'], ['COP', 'Pesos colombianos (COP)'], ['ARS', 'Pesos argentinos (ARS)'], ['CLP', 'Pesos chilenos (CLP)'], ['PEN', 'Soles (PEN)'], ['GTQ', 'Quetzales (GTQ)']])),
      check(p, 'allow_backward', 'Permitir que una tarjeta regrese sola a una columna anterior'),
      h('p', { class: 'small muted' }, 'Las tarjetas avanzan solas hasta ganada o perdida, y a mano puedes moverlas siempre. Si el cliente vuelve por otra cosa, la anterior se cierra y empieza una tarjeta nueva.')),
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
