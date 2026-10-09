import { ACTIONS } from './automation.js';
import { channelIcon, channelStatusCell } from './channels.js';
import { api, area, check, clone, field, fill, fmtDate, h, lines, num, run, select, state, text, toast } from './core.js';
import { importCard, importPreview } from './importer.js';
import { render } from './main.js';
import { tabPlayground } from './playground.js';
import { accountName, isSuper } from './session.js';

/* ------------------------------ Chatbot ------------------------------ */

// La configuración cotidiana: instrucciones, preguntas en orden, cuándo se activa, conocimiento, fotos y pruebas.
const TABS = [
  ['instrucciones', 'Instrucciones'],
  ['preguntas', 'Preguntas'],
  ['activacion', 'Activación'],
  ['conocimiento', 'Conocimiento'],
  ['imagenes', 'Fotos'],
  ['probar', 'Probar'],
];

const TAB_ALIASES = { general: 'instrucciones', personalidad: 'instrucciones', datos: 'preguntas', flujo: 'instrucciones', ia: 'instrucciones', avanzado: 'instrucciones', reglas: 'instrucciones' };

export const dataLabel = (key) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Marca si el sistema hace cumplir un ajuste o si es una guía para la IA. */
const guaranteed = () => h('span', { class: 'badge green', title: 'El sistema lo revisa antes de enviar cada respuesta: si no se cumple, la corrige o pide otra a la IA.' }, '✓ Garantizado');

const guide = () => h('span', { class: 'badge', title: 'Instrucción para la IA. La sigue casi siempre; compruébalo en Probar.' }, 'Guía');

const tag = (label, badge) => h('span', {}, label, ' ', badge);

export async function viewBot(root, id, tab) {
  tab = TAB_ALIASES[tab] || tab || 'instrucciones';
  const bot = await api('GET', `/api/chatbots/${id}`);
  root.append(
    h('div', { class: 'row between' },
      h('h1', {}, bot.name, ' ', h('span', { class: `badge ${bot.active ? 'green' : ''}` }, bot.active ? 'Encendido' : 'Apagado')),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: `#/channels?new=1&chatbot_id=${bot.id}` }, 'Conectar teléfono / ver QR'), h('a', { href: `#/conversations?chatbot_id=${bot.id}` }, 'Ver conversaciones →'))),
    h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { href: `#/bot/${id}/${k}`, class: k === tab ? 'active' : '' }, l))),
  );
  const guidance = {
    instrucciones: 'Define cómo atiende tu agente y qué debe lograr. Los ajustes adicionales están al final.',
    preguntas: 'Define qué preguntas debe hacer el agente y en qué orden. Las respuestas se guardan automáticamente.',
    activacion: 'Elige cuándo debe responder el agente y cuándo debe ponerse en pausa.',
    conocimiento: 'Agrega la información que tu agente puede usar para responder: precios, servicios, horarios y condiciones.',
    imagenes: 'Agrega tus fotos y elige cuándo debe enviarlas el agente.',
    probar: 'Prueba una conversación antes de conectar el agente. Aquí puedes ver sus respuestas y los datos que guarda.',
  };
  root.append(h('p', { class: 'help', style: 'margin:0 0 24px' }, guidance[tab] || guidance.instrucciones));
  const body = h('div');
  root.append(body);
  const views = { instrucciones: tabInstructions, preguntas: tabQuestions, activacion: tabActivation, conocimiento: tabKnowledge, imagenes: tabImages, probar: tabPlayground };
  await (views[tab] || tabInstructions)(body, bot);
}

export function saveBar(onSave, extra) {
  return h('div', { class: 'sticky-save row' }, h('button', { class: 'primary', onclick: onSave }, 'Guardar cambios'), extra);
}

async function saveBot(bot, patch) {
  return run(() => api('PUT', `/api/chatbots/${bot.id}`, patch), 'Guardado ✅');
}

async function tabGeneral(root, bot) {
  const m = { name: bot.name, active: bot.active };
  const channels = bot.channels || [];
  const dup = { account_id: bot.account_id };
  const knowledge = await api('GET', `/api/chatbots/${bot.id}/knowledge`).catch(() => []);
  const steps = [
    [knowledge.some((k) => k.active), 'Tiene la información de tu negocio', 'conocimiento', 'Agrega precios, servicios, horarios y preguntas frecuentes: es lo único que puede afirmar.'],
    [!!bot.personality.prompt.trim(), 'Sabe quién es y a quién atiende', 'personalidad', 'Escribe en "Instrucciones" qué hace tu negocio y qué debe lograr el asistente.'],
    [channels.some((c) => c.active), 'Está en al menos un canal', null, 'Conéctalo a WhatsApp u otro canal con "+ Agregar canal".'],
    [bot.active, 'Está encendido', null, 'Marca "Encendido" abajo y guarda.'],
  ];
  const ready = steps.every(([ok]) => ok);
  root.append(
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, ready ? '✅ Configuración básica completa' : 'Para que tu asistente funcione'),
      h('ul', { class: 'checklist' }, steps.map(([ok, label, tabKey, help]) =>
        h('li', { class: ok ? 'ok' : '' }, h('span', { class: 'mark' }, ok ? '✓' : '○'), ' ',
          tabKey ? h('a', { href: `#/bot/${bot.id}/${tabKey}` }, label) : label,
          ok ? null : h('div', { class: 'small muted' }, help)))),
      h('p', { class: 'small muted', style: 'margin-bottom:0' }, 'Antes de encenderlo, ', h('a', { href: `#/bot/${bot.id}/probar` }, 'pruébalo como si fueras un cliente'), '.')),
    h('div', { class: 'card' },
      field('Nombre del asistente o negocio', text(m, 'name')),
      check(m, 'active', 'Encendido (responde solo a los clientes en sus canales)'),
      isSuper() ? h('p', { class: 'muted small' }, 'Cuenta: ', accountName(bot.account_id)) : null,
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Canales que atiende'),
        h('a', { class: 'btn', href: `#/channels?new=1&chatbot_id=${bot.id}` }, '+ Agregar canal')),
      h('p', { class: 'muted small' }, 'El mismo asistente (información, reglas y fotos) responde igual en todos sus canales.'),
      channels.length
        ? h('table', {}, h('tbody', {}, channels.map((c) => h('tr', { class: 'click', onclick: () => (location.hash = `#/channel/${c.id}`) },
            h('td', {}, channelIcon(c.type), ' ', h('strong', {}, c.name), c.type === 'whatsapp' && c.config.number ? h('div', { class: 'small muted' }, `+${c.config.number}`) : null), h('td', {}, c.label),
            channelStatusCell(c)))))
        : h('p', {}, 'Aún no tiene canales. Mientras tanto puedes probarlo en la pestaña ', h('a', { href: `#/bot/${bot.id}/probar` }, 'Probar'), '.'),
    ),
    saveBar(async () => { if (await saveBot(bot, m)) render(); },
      h('span', { class: 'row', style: 'margin-left:auto' },
        isSuper() ? h('span', { style: 'min-width:180px' }, select(dup, 'account_id', state.accounts.map((a) => [a.id, a.name]))) : null,
        h('button', { onclick: async () => { const c = await run(() => api('POST', `/api/chatbots/${bot.id}/duplicate`, dup), 'Chatbot duplicado'); if (c) location.hash = `#/bot/${c.id}/general`; } }, isSuper() ? 'Duplicar en esa cuenta' : 'Duplicar'),
        h('button', { class: 'danger', onclick: async () => { if (prompt(`Escribe "${bot.name}" para eliminarlo (sus canales quedarán sin chatbot)`) === bot.name) { await run(() => api('DELETE', `/api/chatbots/${bot.id}`), 'Eliminado'); location.hash = '#/'; } } }, 'Eliminar'))),
  );
}

async function tabInstructions(root, bot) {
  const m = { name: bot.name, active: bot.active };
  const p = clone(bot.personality);
  const f = clone(bot.flow);
  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'grid' },
        field('Nombre del agente', text(m, 'name')),
        field('Nombre con el que se presenta (opcional)', text(p, 'assistant_name', { placeholder: 'Mario' }))),
      check(m, 'active', 'Asistente encendido'),
      field('Cómo debe atender', area(p, 'prompt', { big: true, placeholder: 'Eres Mario, el asistente de Los Trompitos. Atiende de forma amable y breve. Ayuda a hacer pedidos. Pregunta qué quieren ordenar, la cantidad y si pasan a recoger o necesitan entrega. Para entrega, pide nombre y dirección. Haz una pregunta a la vez.' }),
        ['Describe cómo debe atender. Las preguntas que debe hacer, en orden, van en ', h('a', { href: `#/bot/${bot.id}/preguntas` }, 'Preguntas'), '; los precios, horarios y productos, en Conocimiento.']),
      field('Objetivo', area(f, 'goal', { placeholder: 'Ayudar al cliente a completar su pedido y pasarlo al equipo para confirmarlo.' })),
      h('p', { class: 'small muted', style: 'margin-bottom:0' }, 'Los datos se guardan automáticamente cuando el cliente responde: nombre, dirección, pedido y cualquier otro dato útil. Para que pregunte algo siempre y en orden, agrégalo en ', h('a', { href: `#/bot/${bot.id}/preguntas` }, 'Preguntas'), '.')),
    h('details', { class: 'card' }, h('summary', {}, 'Estilo de las respuestas'),
      h('div', { class: 'grid', style: 'margin-top:14px' },
        field('Trato', select(p, 'formality', [['tu', 'De tú'], ['usted', 'De usted']])),
        field('Largo', select(p, 'response_length', [['muy_corta', 'Muy cortas'], ['corta', 'Cortas'], ['media', 'Medianas'], ['detallada', 'Detalladas']])),
        field('Emojis', select(p, 'emojis', [['none', 'Ninguno'], ['few', 'Pocos'], ['normal', 'Libre']]))),
      field('Tono', h('input', { value: p.tone.join(', '), oninput: (e) => { p.tone = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); } })),
      field('Idioma', text(p, 'language'))),
    saveBar(async () => { if (await saveBot(bot, { ...m, personality: p, flow: f })) render(); }),
  );
  const advanced = h('details', { class: 'card' }, h('summary', {}, 'Opciones avanzadas'));
  for (const [label, view] of [['Canales y administración', tabGeneral], ['Reglas y transferencia a una persona', tabRules], ['Recorrido y modelo de IA', tabAdvanced]]) {
    const content = h('div', { style: 'margin-top:14px' });
    let loaded = false;
    const section = h('details', { style: 'margin-top:14px', ontoggle: async () => {
      if (!section.open || loaded) return;
      loaded = true;
      try { fill(content); await view(content, bot); }
      catch (error) { loaded = false; fill(content, h('p', { class: 'help' }, 'No se pudo cargar. Cierra y vuelve a abrir para reintentar.')); toast(error.message, true); }
    } }, h('summary', {}, label), content);
    advanced.append(section);
  }
  root.append(advanced);
}

/** Avance del recorrido en una conversación: etapa actual y si se cumplió el objetivo. */
export function flowCard(flow, c) {
  if (!flow || (!flow.goal && !flow.steps?.length)) return null;
  return h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Recorrido'),
    c.goal_completed_at ? h('p', {}, h('span', { class: 'badge green' }, '🎯 Objetivo cumplido'), ' ', h('span', { class: 'small muted' }, fmtDate(c.goal_completed_at))) : flow.goal ? h('p', { class: 'small' }, 'Objetivo: ', flow.goal) : null,
    flow.steps?.length ? h('ol', { class: 'small flow-steps' }, flow.steps.map((st, i) =>
      h('li', { class: i + 1 < (c.flow_step || 0) || (c.goal_completed_at && i + 1 <= (c.flow_step || 0)) ? 'done' : i + 1 === c.flow_step ? 'current' : '' }, st.title))) : null);
}

const CAT_LABELS = { general: 'General', servicios: 'Servicios', productos: 'Productos', precios: 'Precios', horarios: 'Horarios', ubicaciones: 'Ubicación y contacto', condiciones: 'Políticas y condiciones', preguntas_frecuentes: 'Preguntas frecuentes', promociones: 'Promociones', otro: 'Otro' };

const catLabel = (c) => CAT_LABELS[c] || c.replace(/_/g, ' ');

async function tabKnowledge(root, bot) {
  const [items, search] = await Promise.all([api('GET', `/api/chatbots/${bot.id}/knowledge`), api('GET', `/api/chatbots/${bot.id}/knowledge/index`)]);
  if (search.enabled) root.appendChild(h('div', { class: 'card' },
    h('strong', {}, search.available ? 'Búsqueda por significado' : 'Búsqueda por palabras'),
    h('p', { class: 'help' }, search.available ? `${search.indexed_items} documentos preparados · ${search.pending_items ?? 0} pendientes · ${search.essential_items ?? 0} esenciales incluidos siempre. Los cambios se preparan automáticamente; puedes completar los pendientes ahora.` : 'La búsqueda por significado no está disponible. El asistente sigue usando tu conocimiento.'),
    search.available ? h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/chatbots/${bot.id}/knowledge/index`, {}), 'Conocimiento actualizado')) render(); } }, 'Preparar todo ahora') : null));
  const cats = state.meta.knowledge_categories;
  const catOptions = cats.map((c) => [c, catLabel(c)]);
  const newItem = { category: 'general', title: '', content: '', always_include: false };
  const total = items.filter((i) => i.active).reduce((a, i) => a + i.title.length + i.content.length, 0);

  const itemView = (it) => {
    const m = clone(it);
    let editing = false;
    const box = h('div', { class: 'list-item' });
    const draw = () => {
      fill(box, );
      if (!editing) {
        box.append(
          h('div', { class: 'row between' },
            h('div', {},
              h('span', { class: 'badge' }, catLabel(it.category)), ' ',
              h('strong', {}, it.title), ' ',
              !it.active ? h('span', { class: 'badge orange' }, 'inactivo') : null, ' ',
              it.always_include ? h('span', { class: 'badge green' }, 'siempre incluido') : null),
            h('div', { class: 'row' },
              h('button', { class: 'small', onclick: () => { editing = true; draw(); } }, 'Editar'),
              h('button', { class: 'small danger', onclick: async () => { if (confirm('¿Eliminar?')) { await run(() => api('DELETE', `/api/knowledge/${it.id}`), 'Eliminado'); render(); } } }, 'Eliminar'))),
          h('div', { class: 'pre muted', style: 'margin-top:8px' }, it.content),
        );
      } else {
        box.append(
          h('div', { class: 'grid' }, field('Categoría', select(m, 'category', catOptions)), field('Título', text(m, 'title'))),
          field('Contenido', area(m, 'content', { big: true })),
          check(m, 'active', 'Activo'),
          check(m, 'always_include', 'Esencial: tenerlo siempre presente'),
          h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: async () => { if (await run(() => api('PUT', `/api/knowledge/${it.id}`, m), 'Guardado')) render(); } }, 'Guardar'),
            h('button', { onclick: () => { editing = false; draw(); } }, 'Cancelar')),
        );
      }
    };
    draw();
    return box;
  };

  const preview = h('div');
  const sources = [...new Set(items.map((i) => i.source_url).filter(Boolean))];
  root.append(
    importCard({
      endpoint: `/api/chatbots/${bot.id}/knowledge/import`,
      url: sources[0] || '',
      title: items.length ? '⚡ Actualizar desde mi página o archivo' : '⚡ Llena todo por mí',
      button: 'Leer mi información',
      onResult: (data) => importPreview(preview, bot, data),
    }),
    ...(sources.length ? [h('p', { class: 'small muted', style: 'margin:-8px 0 16px' }, 'Información importada de ',
      sources.map((u) => [h('strong', {}, u), ' ', h('button', { class: 'small', onclick: async () => {
        const r = await run(() => api('POST', `/api/chatbots/${bot.id}/knowledge/import`, { url: u, save: true }), 'Actualizado desde tu página ✅');
        if (r) render();
      } }, '🔄 Volver a sincronizar')]))] : []),
    preview,
    h('div', { class: 'card' },
      h('p', { style: 'margin-top:0' },
        'Agrega la información que necesita para responder: productos, precios, horarios y preguntas frecuentes.'),
      h('p', { class: 'small muted', style: 'margin-bottom:0' }, 'Escribe datos concretos, uno por renglón: "Limpieza dental: $600". ',
        total > bot.ai.knowledge_char_budget * 0.7
          ? `Tienes mucha información (${total.toLocaleString()} caracteres): en cada respuesta se usa la más relacionada con la pregunta. Marca como "esencial" lo que siempre deba tener presente.`
          : `${items.length} ${items.length === 1 ? 'tema' : 'temas'} cargados.`),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Agregar información'),
      field('Tema', text(newItem, 'title', { placeholder: 'Ej.: Menú y precios' })),
      field('Contenido', area(newItem, 'content', { big: true, placeholder: 'Habitación sencilla: $1,200 MXN por noche...\nHabitación doble: $1,650 MXN por noche...' })),
      h('details', {}, h('summary', {}, 'Más opciones'), field('Categoría', select(newItem, 'category', catOptions)), check(newItem, 'always_include', 'Tenerlo siempre presente')),
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', `/api/chatbots/${bot.id}/knowledge`, newItem), 'Agregado')) render(); } }, 'Agregar'),
    ),
    ...cats.filter((c) => items.some((i) => i.category === c)).map((c) =>
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, catLabel(c)), items.filter((i) => i.category === c).map(itemView))),
    ...(items.some((i) => !cats.includes(i.category)) ? [h('div', { class: 'card' }, h('h3', {}, 'Otras'), items.filter((i) => !cats.includes(i.category)).map(itemView))] : []),
  );
}

/** Valores de "¿Cuándo se envía?" de una foto (las viejas quedan en "La IA decide"). */
const sendWhenDefaults = (w = {}) => ({ mode: 'ai', context: '', keywords: [], assistant_keywords: [], first_message: false, flow_steps: [], on_goal: false, on_booking: false, once: true, ...w });

/** Editor de "¿Cuándo se envía?": la IA decide, o el sistema la envía en los momentos que marques. */
function sendWhenEditor(w, bot) {
  const box = h('div');
  const steps = bot.flow?.steps || [];
  const draw = () => fill(box,
    field('¿Cuándo se envía?', select(w, 'mode', [['ai', 'La IA decide (según "Cuándo enviarla")'], ['rules', 'Solo en los momentos que marque aquí'], ['both', 'En estos momentos y también cuando la IA lo crea conveniente']], draw)),
    w.mode === 'ai' ? null : h('div', { class: 'list-item' },
      h('p', { class: 'small', style: 'margin-top:0' }, guaranteed(), ' El sistema la envía junto con la respuesta, aunque la IA no la elija, respetando el máximo de fotos por respuesta.'),
      field(tag('Enviar por contexto', guide()), area(w, 'context', { placeholder: 'Cuando el cliente quiera comparar habitaciones o el asistente le explique las opciones disponibles.' }), 'Describe la situación. La IA interpreta la conversación completa; no exige palabras exactas.'),
      field('Cuando el cliente escriba', lines(w, 'keywords', { placeholder: 'menú\nprecios\nubicación' }), 'Una por renglón. Si la vuelve a pedir, se reenvía.'),
      field('Cuando el asistente diga o pregunte', lines(w, 'assistant_keywords', { placeholder: 'qué tipo de habitación\ncuál prefieres' }), 'Una frase por renglón. Se comprueba en la respuesta que se envía al cliente.'),
      check(w, 'first_message', 'En la bienvenida (primera respuesta a un cliente nuevo)'),
      steps.length
        ? h('div', {}, h('span', { class: 'small' }, 'Al llegar a la etapa del recorrido: '), steps.map((st, i) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: w.flow_steps.includes(i + 1), onchange: (e) => { w.flow_steps = e.target.checked ? [...w.flow_steps, i + 1] : w.flow_steps.filter((x) => x !== i + 1); } }), `${i + 1}. ${st.title}`)))
        : null,
      check(w, 'on_goal', 'Al cumplirse el objetivo de la conversación'),
      check(w, 'on_booking', 'Al agendar una cita (p. ej. mapa o indicaciones)'),
      check(w, 'once', 'Solo una vez por conversación')));
  draw();
  return box;
}

/** Aviso de formato: WhatsApp muestra mejor JPG/PNG; las fotos pesadas tardan en llegar. */
function imageFileHint(input) {
  const hint = h('small', {}, 'JPG o PNG recomendados (máx. 5 MB).');
  input.addEventListener('change', () => {
    const f = input.files[0];
    if (!f) return;
    const warn = [];
    if (f.type === 'image/webp') warn.push('WEBP: en algunos teléfonos WhatsApp no la muestra bien; mejor JPG o PNG.');
    if (f.size > 5 * 1024 * 1024) warn.push('Pesa más de 5 MB: no se podrá subir; redúcela.');
    else if (f.size > 2 * 1024 * 1024) warn.push('Pesa más de 2 MB: tardará más en llegar; conviene reducirla.');
    hint.textContent = warn.join(' ') || 'Formato correcto.';
    hint.className = warn.length ? 'error' : '';
  });
  return hint;
}

export async function tabImages(root, bot) {
  const images = await api('GET', `/api/chatbots/${bot.id}/images`);
  const n = { code: '', name: '', description: '', usage_rule: '', caption: '', send_when: sendWhenDefaults() };
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const upload = async () => {
    if (!fileInput.files[0]) return toast('Selecciona un archivo', true);
    const fd = new FormData();
    for (const [k, v] of Object.entries(n)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : v);
    fd.append('file', fileInput.files[0]);
    if (await run(() => api('POST', `/api/chatbots/${bot.id}/images`, fd, true), 'Imagen agregada')) render();
  };
  const card = (img) => {
    const m = clone(img);
    m.send_when = sendWhenDefaults(m.send_when);
    const replace = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const save = async () => {
      const fd = new FormData();
      for (const k of ['code', 'name', 'description', 'usage_rule', 'caption']) fd.append(k, m[k] ?? '');
      fd.append('send_when', JSON.stringify(m.send_when));
      fd.append('active', String(m.active));
      if (replace.files[0]) fd.append('file', replace.files[0]);
      if (await run(() => api('PUT', `/api/images/${img.id}`, fd, true), 'Imagen actualizada')) render();
    };
    return h('div', { class: 'img-card' },
      h('img', { src: `/api/images/${img.id}/file?v=${encodeURIComponent(img.file_path)}`, alt: img.name, loading: 'lazy' }),
      h('div', { class: 'body' },
        h('div', { class: 'row between' }, h('code', {}, img.code),
          h('span', {}, m.send_when.mode !== 'ai' ? h('span', { class: 'badge green' }, 'envío automático') : null, ' ', !img.active ? h('span', { class: 'badge orange' }, 'inactiva') : null)),
        field('ID (lo usa la IA)', text(m, 'code')),
        field('Nombre', text(m, 'name')),
        field('Qué muestra', area(m, 'description')),
        field(tag('Cuándo enviarla', guide()), area(m, 'usage_rule'), 'Para la IA (modos "La IA decide" y "Ambos").'),
        h('details', {}, h('summary', {}, 'Reglas de envío'), sendWhenEditor(m.send_when, bot)),
        field('Pie de foto (opcional)', text(m, 'caption')),
        check(m, 'active', 'Activa'),
        field('Reemplazar archivo', replace, imageFileHint(replace)),
        h('div', { class: 'row' },
          h('button', { class: 'primary small', onclick: save }, 'Guardar'),
          h('button', { class: 'small danger', onclick: async () => { if (confirm('¿Eliminar imagen?')) { await run(() => api('DELETE', `/api/images/${img.id}`), 'Eliminada'); render(); } } }, 'Eliminar'))),
    );
  };
  root.append(
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'Sube fotos y escribe cuándo debe enviarlas el asistente. Opcionalmente puedes definir reglas de envío (', guaranteed(), ').'),
      h('h3', {}, 'Agregar imagen'),
      h('div', { class: 'grid' },
        field('ID', text(n, 'code', { placeholder: 'habitacion_doble' }), 'Minúsculas, números, - y _'),
        field('Nombre', text(n, 'name', { placeholder: 'Foto habitación doble' })),
        field('Archivo', fileInput, imageFileHint(fileInput))),
      field('Qué muestra', area(n, 'description', { placeholder: 'Habitación doble con dos camas matrimoniales y vista al mar' })),
      field(tag('Cuándo enviarla', guide()), area(n, 'usage_rule', { placeholder: 'Cuando el cliente pregunte por la habitación doble o pida fotos de las habitaciones' })),
      h('details', {}, h('summary', {}, 'Reglas de envío (opcional)'), sendWhenEditor(n.send_when, bot)),
      field('Pie de foto (opcional)', text(n, 'caption')),
      h('button', { class: 'primary', onclick: upload }, 'Subir imagen'),
    ),
    h('div', { class: 'grid' }, images.map(card)),
    savedMessagesCard(bot, images),
  );
}

/** Mensajes guardados: textos (y fotos) que el asistente envía tal cual; la IA los elige por su código. */
function savedMessagesCard(bot, images) {
  const list = clone(bot.saved_messages || []);
  const steps = bot.flow?.steps || [];
  const photos = [['', '— Sin foto —'], ...images.filter((im) => im.active).map((im) => [im.id, `${im.name} (${im.code})`])];
  const box = h('div');
  const draw = () => fill(box,
    list.length
      ? list.map((m, i) => h('div', { class: 'card', style: 'background:var(--bg)' },
        h('div', { class: 'grid' },
          field('Código', text(m, 'code', { placeholder: 'precios' }), 'Con este código lo menciona el prompt y lo elige la IA.'),
          field('Título', text(m, 'title', { placeholder: 'Lista de precios' })),
          field('Foto (opcional)', select(m, 'image_id', m.image_id && !photos.some(([id]) => id === m.image_id) ? [...photos, [m.image_id, '⚠ Foto borrada o inactiva: elige otra o quítala']] : photos))),
        field('Texto', area(m, 'text', { placeholder: 'Nuestras tarifas: habitación doble $1,650 MXN por noche, desayuno incluido.' }), 'Se envía tal cual. Si tiene foto, va como pie de la foto en un solo mensaje.'),
        field(tag('Cuándo enviarlo', guide()), text(m, 'when', { placeholder: 'Cuando el cliente pregunte por precios o tarifas' })),
        h('div', { class: 'grid' },
          field('Etapa del recorrido al enviarlo', num(m, 'flow_step', { min: 0, max: steps.length }),
            steps.length ? `0 = no cambia. ${steps.map((st, n) => `${n + 1}. ${st.title}`).join(' · ')}` : 'Define etapas en el recorrido para usar esta opción.'),
          h('div', {}, check(m, 'active', 'Activo'), h('button', { class: 'small danger', onclick: () => { list.splice(i, 1); draw(); } }, 'Quitar'))),
      ))
      : h('p', { class: 'muted small' }, 'Aún no hay mensajes guardados.'),
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => { list.push({ code: '', title: '', text: '', image_id: '', when: '', flow_step: 0, active: true }); draw(); } }, '+ Agregar mensaje'),
      h('button', { class: 'primary', onclick: async () => { if (await saveBot(bot, { saved_messages: list })) render(); } }, 'Guardar mensajes')));
  draw();
  return h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Mensajes guardados (texto + foto)'),
    h('p', { class: 'small muted' }, 'El asistente los envía tal cual cuando se cumple su condición; con foto, salen juntos en un solo mensaje. En el prompt menciónalos por su código, por ejemplo: "si piden precios, envía el mensaje precios".'),
    box);
}

const QUESTION_TYPES = [['text', 'Texto libre'], ['name', 'Nombre'], ['email', 'Correo'], ['phone', 'Teléfono'], ['date', 'Fecha'], ['number', 'Número'], ['option', 'Una de varias opciones']];

// Palabras que el sistema trata como dato sensible (nunca guarda la respuesta): no van en una clave generada.
const SENSITIVE_WORDS = /^(tarjeta|tarjetas|card|cvv|cvc|contrasena|password|passwd|nip|pin|clave)$/;

/** Clave del dato a partir del texto de la pregunta ("¿Para qué fecha?" → para_que_fecha). */
function questionKey(text) {
  const words = (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !SENSITIVE_WORDS.test(w));
  const base = words.join('_').slice(0, 40).replace(/_+$/g, '');
  return /^[a-z]/.test(base) ? base : `pregunta${base ? `_${base}` : ''}`;
}

/** Apartado "Preguntas": lista ordenada que el asistente sigue paso a paso, una por mensaje (lo garantiza el sistema). */
function tabQuestions(root, bot) {
  const all = clone(bot.data_fields || []);
  const originalKeys = new Set(all.map((f) => f.key));
  // Los datos sin pregunta (p. ej. de una plantilla) se piden cuando tenga sentido; se pueden quitar aquí.
  const others = all.filter((f) => !f.question?.trim());
  // Clave con la que llegó cada pregunta: para seguir el cambio en el desactivador "ya dio estos datos".
  const qs = all.filter((f) => f.question?.trim()).map((f) => ({ ...f, _from: f.key }));
  const r = clone(bot.rules);
  const a = r.activation;
  const list = h('div');
  const draw = () => fill(list,
    qs.length
      ? qs.map((q, i) => h('div', { class: 'list-item' },
        h('div', { class: 'row between' }, h('strong', {}, `Pregunta ${i + 1}`),
          h('div', { class: 'row' },
            h('button', { class: 'small', disabled: i === 0, onclick: () => { [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; draw(); } }, '↑'),
            h('button', { class: 'small', disabled: i === qs.length - 1, onclick: () => { [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; draw(); } }, '↓'),
            h('button', { class: 'small danger', onclick: () => { qs.splice(i, 1); draw(); } }, 'Quitar'))),
        field('Pregunta (se envía tal cual)', text(q, 'question', { placeholder: '¿Para qué fecha te gustaría reservar?' })),
        h('div', { class: 'grid' },
          field('Tipo de respuesta', select(q, 'type', QUESTION_TYPES, draw)),
          field('Se guarda como', text(q, 'key', { placeholder: 'Se genera de la pregunta' }), 'Minúsculas, números y guion bajo (ej. fecha_llegada). Si coincide con un dato de abajo, la pregunta lo reemplaza.')),
        q.type === 'option' ? field('Opciones', lines(q, 'options', { placeholder: 'Sencilla\nDoble\nSuite' }), 'Una por renglón.') : null,
        check(q, 'required', 'Obligatoria: si no la contesta, se le vuelve a preguntar (las opcionales se hacen una sola vez)')))
      : h('p', { class: 'muted' }, 'Aún no hay preguntas. Agrégalas en el orden en que el asistente debe hacerlas.'));
  draw();
  const otherBox = h('div');
  const drawOthers = () => fill(otherBox, others.length
    ? [h('p', { class: 'small muted', style: 'margin-bottom:4px' }, 'Además guarda estos datos cuando el cliente los mencione (sin pregunta fija):'),
      h('div', { class: 'row' }, others.map((f, i) => h('span', { class: 'badge' }, f.label || f.key, ' ',
        h('button', { class: 'small', title: 'Quitar este dato', onclick: () => { others.splice(i, 1); drawOthers(); } }, '×'))))]
    : []);
  drawOthers();
  const save = async () => {
    // 1) Textos y claves escritas a mano (se revisan antes de generar las demás).
    const explicit = new Set();
    for (const q of qs) {
      q.question = (q.question || '').trim();
      if (!q.question) return toast('Escribe el texto de cada pregunta o quítala.', true);
      const key = (q.key || '').trim();
      if (!key) continue;
      if (!/^[a-z0-9_]+$/.test(key)) return toast(`La clave "${key}" solo puede tener minúsculas, números y guion bajo.`, true);
      if (explicit.has(key)) return toast(`La clave "${key}" se repite: cada pregunta guarda su respuesta en una clave distinta.`, true);
      explicit.add(key);
    }
    // 2) Claves generadas: nunca chocan con las escritas a mano ni con los demás datos.
    const used = new Set([...explicit, ...others.map((f) => f.key)]);
    const keys = qs.map((q) => {
      const key = (q.key || '').trim();
      if (key) return key;
      const base = questionKey(q.question);
      let k = base;
      for (let n = 2; used.has(k); n++) k = `${base}_${n}`;
      used.add(k);
      return k;
    });
    // Una pregunta con la clave de un dato sin pregunta lo reemplaza: es el mismo dato, ahora en orden.
    const rest = others.filter((f) => !keys.includes(f.key));
    const fields = qs.map((q, i) => {
      const { _from, ...f } = q;
      const prev = others.find((x) => x.key === keys[i]);
      // La etiqueta generada sigue a la clave; una escrita a propósito se respeta.
      const autoLabel = !f.label || f.label === dataLabel(_from || '');
      return { ...prev, ...f, key: keys[i], label: autoLabel ? prev?.label || dataLabel(keys[i]) : f.label, options: (f.options || []).filter((x) => x.trim()) };
    });
    // Desactivador "ya dio estos datos": sigue a las claves que cambiaron y suelta las de preguntas o datos quitados.
    const renamed = new Map(qs.map((q, i) => [q._from, keys[i]]).filter(([from, to]) => from && from !== to));
    const exists = new Set([...fields, ...rest].map((f) => f.key));
    const offFields = [...new Set(a.off_when_fields.map((k) => renamed.get(k) ?? k))].filter((k) => exists.has(k) || !originalKeys.has(k));
    if (await saveBot(bot, { data_fields: [...fields, ...rest], rules: { activation: { off_on_questions: !!a.off_on_questions, off_when_fields: offFields } } })) render();
  };
  root.append(
    h('div', { class: 'card legend' }, h('p', { style: 'margin:0' }, guaranteed(), ' El asistente hace estas preguntas en orden, una por mensaje y con tu texto. Si el cliente pregunta otra cosa, le responde y retoma la pregunta pendiente; si ya dio un dato, no se lo vuelve a preguntar. Las respuestas se guardan en el contacto. Compruébalo en ', h('a', { href: `#/bot/${bot.id}/probar` }, 'Probar'), '.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Preguntas (en orden)'),
      list,
      h('button', { onclick: () => { qs.push({ key: '', label: '', type: 'text', description: '', options: [], required: true, ask_when: '', question: '', _from: '' }); draw(); } }, '+ Agregar pregunta'),
      otherBox),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Al terminar las preguntas'),
      check(a, 'off_on_questions', tag('Apagar el asistente en esa conversación cuando el cliente responda todas las preguntas', guaranteed())),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Responde ese último mensaje y después se apaga. Qué pasa al apagarse (pausa, pasar a una persona o cerrar) y el mensaje de despedida se configuran en ', h('a', { href: `#/bot/${bot.id}/activacion` }, 'Activación'), '.')),
    saveBar(save),
  );
}

function tabRules(root, bot) {
  const r = clone(bot.rules);
  root.append(
    h('div', { class: 'card legend' },
      h('p', { style: 'margin:0' }, guaranteed(), ' El sistema lo revisa antes de enviar cada respuesta; si no se cumple, la corrige o pide otra a la IA. ',
        guide(), ' Instrucción para la IA: la sigue casi siempre. Compruébalo en ', h('a', { href: `#/bot/${bot.id}/probar` }, 'Probar'), '.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Cuando no tiene un dato'),
      check(r, 'verify_facts', tag('No inventar precios, cantidades, teléfonos, correos ni enlaces (recomendado)', guaranteed())),
      field('No afirmar lo que no esté en tu información (p. ej. "sí tenemos alberca")', select(r, 'verify_claims', [['reglas', 'Revisión rápida (recomendado)'], ['estricto', 'Estricta: una segunda IA lo revisa (más segura, cuesta un poco más)'], ['apagado', 'Sin revisar']]), 'Cuando el asistente asegura que tienes u ofreces algo que no está cargado, se corrige o dice que lo confirma con tu equipo.'),
      field(tag('Si le preguntan algo que no está en "Conocimiento"…', guaranteed()), select(r, 'unknown_info_behavior', [['say_unknown', 'Decir que no lo tiene confirmado'], ['ask', 'Hacer una pregunta para entender mejor'], ['handoff', 'Pasar con una persona del equipo']])),
      field(tag('Mensaje de respaldo', guaranteed()), area(r, 'fallback_message'), 'Se envía tal cual si la IA insiste en un dato que no puede comprobarse.'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Pasar con una persona'),
      field(tag('Palabras que pasan con una persona de inmediato', guaranteed()), lines(r, 'handoff_keywords'), 'Si el cliente escribe alguna, se transfiere sin consultar a la IA.'),
      field(tag('Cuándo pasar con una persona', guide()), lines(r, 'handoff_rules'), 'Situaciones, una por renglón: "El cliente quiere pagar", "Tiene una queja".'),
      field(tag('Mensaje al pasar con una persona', guaranteed()), area(r, 'handoff_message'), 'Se envía tal cual. Después el asistente deja de responder en esa conversación hasta que se la devuelvas.'),
      field('WhatsApp que recibe el aviso', text(r, 'handoff_notify_number', { placeholder: '5215512345678' }), 'Opcional, con lada. Además se avisa en el panel y por WhatsApp a quien lo tenga activado en "Mi perfil".'),
      field('El asistente retoma la conversación después de (minutos)', num(r, 'auto_resume_minutes', { min: 0 }), '0 = nunca solo; se la devuelves desde Conversaciones.'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Temas y reglas de tu negocio'),
      field(tag('Temas de los que no debe hablar', guaranteed()), lines(r, 'forbidden_topics', { placeholder: 'Política\nCompetencia' }),
        'Si los menciona sin que el cliente pregunte, se quitan de la respuesta. Si el cliente pregunta, declina con amabilidad.'),
      field(tag('Reglas de tu negocio', guide()), lines(r, 'custom_rules', { big: true, placeholder: 'Nunca ofrezcas descuentos\nSiempre pregunta las fechas antes de hablar de disponibilidad\nNo confirmes reservaciones: eso lo hace una persona' }),
        'Una por renglón, concretas. Lo que tenga precio o cifra, escríbelo también en "Conocimiento": así queda garantizado.'),
      field(tag('De qué puede hablar', guide()), area(r, 'allowed_topics', { placeholder: 'Reservaciones, habitaciones, servicios del hotel, ubicación' }), 'Opcional. Si le preguntan algo ajeno, redirige la conversación.'),
      field(tag('Frases que nunca debe usar', guaranteed()), lines(r, 'banned_phrases'), 'Si aparece alguna, la respuesta se rehace.'),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Fotos'),
      field(tag('Cuándo mandar fotos', guide()), area(r, 'image_rules', { placeholder: 'Envía la foto de una habitación cuando el cliente pregunte por ella o quiera verla.' })),
      h('div', { class: 'grid' }, field(tag('Máximo de fotos por respuesta', guaranteed()), num(r, 'max_images_per_reply', { min: 0, max: 5 }))),
      check(r, 'avoid_repeating_images', tag('No reenviar fotos ya enviadas (salvo que el cliente las pida)', guaranteed())),
      h('p', { class: 'small muted' }, guaranteed(), ' Solo se envían fotos de tu catálogo; nunca promete una foto que no existe.'),
    ),
    saveBar(async () => { if (await saveBot(bot, { rules: r })) render(); }),
  );
}

/** Activadores y desactivadores: cuándo empieza a responder el asistente y cuándo se apaga en una conversación. */
function tabActivation(root, bot) {
  const r = clone(bot.rules);
  const a = r.activation;
  const fields = bot.data_fields || [];
  const questionCount = fields.filter((f) => f.question?.trim()).length;
  // También los datos marcados que no están en la lista (automáticos como "telefono"), para poder desmarcarlos.
  const dataChoices = [...fields, ...a.off_when_fields.filter((k) => !fields.some((f) => f.key === k)).map((k) => ({ key: k, label: dataLabel(k) }))];
  const onBox = h('div');
  const drawOn = () => fill(onBox,
    field(tag('¿Cuándo empieza a responder?', guaranteed()), select(a, 'mode', [['always', 'Siempre: a cualquier mensaje'], ['keywords', 'Solo cuando el cliente escriba una de estas palabras']], drawOn)),
    field(a.mode === 'keywords' ? 'Palabras que lo activan' : 'Palabras que lo reactivan si está en pausa', lines(a, 'on_keywords', { placeholder: 'info\nquiero información\nhola asistente' }),
      a.mode === 'keywords'
        ? 'Una por renglón. Hasta que el cliente escriba alguna, el asistente no contesta en esa conversación (tus reglas automáticas sí funcionan). Después responde normal.'
        : 'Opcional. Una por renglón. Si el asistente está en pausa en una conversación y el cliente escribe alguna, vuelve a responder.'));
  drawOn();
  root.append(
    h('div', { class: 'card legend' }, h('p', { style: 'margin:0' }, guaranteed(), ' Todo esto lo aplica el sistema, no la IA: funciona siempre igual. No distingue mayúsculas ni acentos, y busca palabras o frases completas. Pruébalo abajo o en ', h('a', { href: `#/bot/${bot.id}/probar` }, 'Probar'), '.')),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, '1. Activadores'), onBox),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, '2. Desactivadores'),
      h('p', { class: 'small muted', style: 'margin-top:0' }, 'El asistente se apaga solo en esa conversación (con los demás clientes sigue igual).'),
      field('Cuando el cliente escriba alguna de estas palabras', lines(a, 'off_keywords', { placeholder: 'ya no\ngracias es todo\nno me interesa' }), 'Una por renglón. No se le pregunta a la IA.'),
      check(a, 'off_on_goal', ['Cuando se cumpla el objetivo de la conversación', bot.flow?.goal ? h('span', { class: 'muted small' }, ` (“${bot.flow.goal}”)`) : h('span', { class: 'muted small' }, ' (define el objetivo en ', h('a', { href: `#/bot/${bot.id}/instrucciones` }, 'Instrucciones'), ')')]),
      check(a, 'off_on_booking', 'Cuando el cliente agende una cita o llamada'),
      check(a, 'off_on_questions', ['Cuando el cliente responda todas las preguntas', questionCount ? h('span', { class: 'muted small' }, ` (${questionCount} en la lista)`) : h('span', { class: 'muted small' }, ' (agrégalas en ', h('a', { href: `#/bot/${bot.id}/preguntas` }, 'Preguntas'), ')')]),
      field('Cuando el cliente ya haya dado todos estos datos',
        dataChoices.length
          ? h('div', { class: 'row' }, dataChoices.map((f) => h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: a.off_when_fields.includes(f.key), onchange: (e) => { a.off_when_fields = e.target.checked ? [...a.off_when_fields, f.key] : a.off_when_fields.filter((k) => k !== f.key); } }), f.label)))
          : h('p', { class: 'small muted', style: 'margin:0' }, 'Los datos se guardan al conversar. Configura las preguntas en ', h('a', { href: `#/bot/${bot.id}/preguntas` }, 'Preguntas'), '.'),
        'Responde ese mensaje y después se apaga. Ej.: al tener nombre y teléfono, para que una persona continúe.')),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, '3. Al desactivarse'),
      field('Qué pasa', select(a, 'off_action', [['pause', 'Se pone en pausa en silencio (no avisa a nadie)'], ['handoff', 'Pasa la conversación a una persona (avisa al equipo)'], ['close', 'Cierra la conversación (si el cliente vuelve a escribir, empieza de nuevo)']])),
      field('Mensaje al desactivarse (opcional)', area(a, 'off_message', { placeholder: 'Gracias, en breve una persona del equipo te contacta.' }), 'Se envía tal cual. Vacío = no se envía nada.'),
      h('div', { class: 'grid' }, field('Se reactiva solo después de (horas)', num(a, 'resume_after_hours', { min: 0, max: 720 }), '0 = solo con una palabra de activación, una regla o el botón "Reactivar asistente" en la conversación.'))),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, '4. Cuando una persona escribe'),
      check(r, 'pause_on_human_reply', tag('Si alguien del equipo contesta desde el teléfono, el asistente se calla en esa conversación', guaranteed())),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Aplica también si la conversación está cerrada, y queda registrado en el contacto quién la atendió y cuándo. Lo que escribes desde el panel siempre pausa al asistente.')),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Probar palabras'), messageTester([bot], bot.id)),
    saveBar(async () => {
      a.on_keywords = a.on_keywords.filter((x) => x.trim());
      if (a.mode === 'keywords' && !a.on_keywords.length) return toast('Escribe al menos una palabra que active al asistente', true);
      if (await saveBot(bot, { rules: r })) render();
    }),
  );
}

/**
 * Probador sin IA: qué pasaría si un cliente escribe un mensaje (bajas, reglas, activadores,
 * desactivadores y transferencia). Usa la configuración guardada; no envía ni guarda nada.
 */
export function messageTester(bots, botId) {
  const t = { bot: botId || bots[0]?.id || '', text: '', first: true, agent: '', channel: 'whatsapp' };
  const out = h('div');
  const go = async () => {
    if (!t.text.trim()) return toast('Escribe un mensaje de prueba', true);
    const r = await run(() => api('POST', `/api/chatbots/${t.bot}/test-message`, { text: t.text, first_message: t.first, channel_type: t.channel, agent: t.agent || undefined }));
    if (!r) return;
    fill(out,
      h('p', {}, h('span', { class: `badge ${r.ai_replies ? 'green' : 'orange'}` }, r.ai_replies ? 'La IA respondería' : 'La IA no responde'), ' ', r.why),
      h('ul', { class: 'small' }, r.steps.map((s) => h('li', {}, h('strong', {}, s.title, ': '), s.detail))),
      r.rules.length
        ? h('table', { class: 'small' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Regla'), h('th', {}, 'Resultado'), h('th', {}, 'Acciones'))),
            h('tbody', {}, r.rules.map((x) => h('tr', {},
              h('td', {}, x.matched ? '✅' : '❌'),
              h('td', {}, h('a', { href: `#/automation/rules/${x.id}` }, x.name)),
              h('td', { class: x.matched ? '' : 'muted' }, x.reason),
              h('td', { class: 'muted' }, x.actions.map((k) => ACTIONS[k] || k).join(' → '), x.stop_ai ? ' · la IA no responde' : '')))))
        : null,
      h('p', { class: 'small muted' }, 'Las reglas por intención las decide la IA: pruébalas en el Simulador.'));
  };
  const input = h('input', { type: 'text', placeholder: 'Escribe un mensaje como si fueras el cliente…', oninput: (e) => (t.text = e.target.value), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } } });
  return h('div', {},
    h('p', { class: 'small muted', style: 'margin-top:0' }, 'Sin IA y sin enviar nada: te dice qué reglas, activadores y desactivadores se dispararían. Usa lo que ya está guardado.'),
    h('div', { class: 'grid' },
      bots.length > 1 ? field('Asistente', select(t, 'bot', bots.map((b) => [b.id, b.name]))) : null,
      field('Mensaje', input),
      field('Estado del asistente en esa conversación', select(t, 'agent', [['', 'Como empieza una conversación nueva'], ['on', 'Activo'], ['paused', 'En pausa'], ['waiting', 'Esperando palabra de activación']])),
      field('Canal', select(t, 'channel', (state.meta?.channel_types || [{ type: 'whatsapp', label: 'WhatsApp' }]).map((c) => [c.type, c.label])))),
    check(t, 'first', 'Es el primer mensaje del cliente'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: go }, 'Probar')),
    out);
}

function tabAdvanced(root, bot) {
  const f = clone(bot.flow);
  const a = clone(bot.ai);
  root.append(
    h('div', { class: 'card legend' }, h('p', { style: 'margin:0' }, 'No necesitas cambiar nada aquí para que tu asistente funcione. Son ajustes finos del recorrido de la conversación y del modelo de IA.')),
    flowSection(f),
    aiSection(a),
    saveBar(async () => { if (await saveBot(bot, { flow: f, ai: a })) render(); }),
  );
}

function flowSection(f) {
  const list = h('div');
  const draw = () => {
    fill(list, 
      ...f.steps.map((s, i) =>
        h('div', { class: 'list-item' },
          h('div', { class: 'row between' }, h('strong', {}, `Etapa ${i + 1}`),
            h('div', { class: 'row' },
              h('button', { class: 'small', disabled: i === 0, onclick: () => { [f.steps[i - 1], f.steps[i]] = [f.steps[i], f.steps[i - 1]]; draw(); } }, '↑'),
              h('button', { class: 'small', disabled: i === f.steps.length - 1, onclick: () => { [f.steps[i + 1], f.steps[i]] = [f.steps[i], f.steps[i + 1]]; draw(); } }, '↓'),
              h('button', { class: 'small danger', onclick: () => { f.steps.splice(i, 1); draw(); } }, 'Quitar'))),
          field('Título', text(s, 'title', { placeholder: 'Entender qué busca' })),
          field('Descripción', area(s, 'description', { placeholder: 'Pregunta fechas y número de personas si no los ha dicho' })),
        )),
    );
  };
  draw();
  return h('div', {},
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Recorrido de la conversación ', guide()),
      h('p', { class: 'muted' }, 'Es una guía, no un guion: el cliente puede saltar pasos o dar todo junto y el asistente se adapta.'),
      field('Objetivo de la conversación', area(f, 'goal', { placeholder: 'Que el cliente haga una reservación o deje sus datos para que un asesor lo contacte.' })),
      field('Saludo sugerido', text(f, 'greeting', { placeholder: '¡Hola! Gracias por escribir al Hotel Las Palmas 🌴' })),
      h('h3', {}, 'Etapas sugeridas'),
      list,
      h('button', { onclick: () => { f.steps.push({ title: '', description: '' }); draw(); } }, '+ Agregar etapa'),
      h('div', { style: 'margin-top:14px' },
        field(tag('Cuando se cumpla el objetivo, el asistente…', guide()), area(f, 'on_goal_completed', { placeholder: 'Agradece y confirma los datos recibidos.' })),
        field(tag('…y además el sistema', guaranteed()), select(f, 'on_goal_action', [['none', 'No hace nada más'], ['handoff', 'Pasa la conversación a una persona'], ['notify', 'Avisa al equipo con el reporte completo (panel y WhatsApp)']]),
          'El asistente reconoce cuándo se cumple el objetivo con las respuestas del cliente. Pasa una sola vez por recorrido. Al cumplirse, el equipo recibe el resumen, los datos confirmados y los pendientes; también puedes usarlo como disparador en Automatización (por ejemplo, para enviar el reporte por correo).')),
    ));
}

function aiSection(a) {
  return h('div', {},
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Modelo de IA'),
      h('div', { class: 'grid' },
        field('Modelo de IA (OpenRouter)', text(a, 'model', { placeholder: state.meta.default_model }), `Vacío = ${state.meta.default_model}`),
        field('Modelos de respaldo (opcional)', lines(a, 'fallback_models', { placeholder: 'Uno por renglón (máx. 2)' }), 'Si el modelo principal falla o está saturado, se usa el siguiente. Vacío = los que configuró el administrador del servidor.'),
        field('Temperatura', num(a, 'temperature', { step: 0.1, min: 0, max: 2, nullable: true }), 'Menor = más consistente. Se ignora en modelos de razonamiento.'),
        field('Esfuerzo de razonamiento', select(a, 'reasoning_effort', [['', 'Por defecto'], ['minimal', 'Mínimo'], ['low', 'Bajo'], ['medium', 'Medio'], ['high', 'Alto']]), 'Solo modelos gpt-5 / o-series.')),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Memoria y contexto'),
      h('div', { class: 'grid' },
        field('Mensajes recientes enviados a la IA', num(a, 'recent_messages', { min: 2, max: 60 })),
        field('Resumir cada N mensajes adicionales', num(a, 'summary_batch', { min: 4, max: 100 }), 'Lo más antiguo se resume para no mandar todo el historial.'),
        field('Presupuesto de conocimiento (caracteres)', num(a, 'knowledge_char_budget', { min: 1000, step: 1000 }))),
    ),
    h('div', { class: 'card' },
      h('h3', { style: 'margin-top:0' }, 'Comportamiento en el chat'),
      h('div', { class: 'grid' },
        field('Esperar antes de responder (segundos)', num(a, 'debounce_seconds', { min: 0, max: 60, step: 0.5 }), 'Agrupa mensajes seguidos del cliente.'),
        field(tag('Máximo de mensajes por respuesta', guaranteed()), num(a, 'max_bubbles', { min: 1, max: 5 })),
        field(tag('Máximo de caracteres por mensaje', guaranteed()), num(a, 'max_chars_per_bubble', { min: 80, max: 2000 }), 'Los mensajes más largos se dividen.')),
      h('p', { class: 'small muted' }, 'La zona horaria y el horario de atención que conoce el asistente se toman de ', h('a', { href: '#/automation/settings' }, 'Automatización → Horario y ajustes'), '.'),
      check(a, 'typing_simulation', 'Mostrar "escribiendo…" antes de cada mensaje'),
      check(a, 'transcribe_audio', 'Entender notas de voz (las transcribe; tiene un costo pequeño por minuto)'),
    ));
}
