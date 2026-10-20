import { discardDraft, draftModel } from './editing.js';
import { importCard, importFrom, IMPORT_ACCEPT, SECTION_LABELS } from './importer.js';
import { api, area, field, fill, h, select, state, text, toast } from './core.js';
import { accountPicker } from './dashboard.js';
import { render } from './main.js';
import { isSuper } from './session.js';

/* ------------------------------ Crear un agente: 1. Tu negocio · 2. Qué hará ------------------------------ */

export const STEPS = ['Tu negocio', 'Qué hará', 'Pruébalo y conéctalo'];

/** Indicador de pasos. No son enlaces: se avanza y se regresa con los botones. `current` = 3 marca todo terminado. */
export function stepsBar(current) {
  return h('ol', { class: 'steps', 'aria-label': 'Pasos para crear tu agente' }, STEPS.map((label, i) =>
    h('li', { class: i < current ? 'done' : i === current ? 'current' : '', 'aria-current': i === current ? 'step' : null },
      h('span', { class: 'step' }, h('span', { class: 'num', 'aria-hidden': 'true' }, i < current ? '✓' : i + 1), label))));
}

const ROLES = [
  ['assist', 'Resolver dudas', 'Contesta precios, horarios y ubicación con tu información; si quieren avanzar, te pasa al cliente.', '«¿Cuánto cuesta la limpieza?» → «Cuesta $600 y dura 45 minutos. ¿Quieres que alguien del equipo te aparte un lugar?»'],
  ['book', 'Agendar citas', 'Además ofrece los horarios libres de tu agenda y confirma la cita.', '«¿Tienen lugar mañana?» → «Sí, a las 10:00 o a las 12:30. ¿Cuál te queda mejor?»'],
  ['sell', 'Tomar pedidos', 'Toma el pedido completo y te lo pasa para que lo confirmes y lo cobres.', '«Quiero dos pizzas grandes» → «¡Claro! ¿A qué dirección te las enviamos?»'],
  ['filter', 'Solo tomar datos y pasarte al cliente', 'No cotiza ni cierra nada: entiende qué necesita, toma sus datos y te avisa.', '«Quiero una cotización» → «Con gusto. ¿Me compartes tu nombre y qué necesitas? Alguien del equipo te contacta enseguida.»'],
];
const COLLECT = [['nombre', 'Nombre'], ['telefono', 'Teléfono (WhatsApp ya lo da)'], ['correo', 'Correo'], ['ciudad', 'Ciudad o zona'], ['interes', 'Qué le interesa'], ['presupuesto', 'Presupuesto'], ['fecha', 'Fecha o momento'], ['personas', 'Número de personas']];
const SOURCES = [
  ['url', '🌐 Mi página web', 'Tu sitio, tu menú en línea o una hoja de Google Sheets compartida.'],
  ['file', '📄 Un archivo', 'PDF, foto de tu menú o lista de precios, o CSV. ¿Tienes Excel? Guárdalo como CSV o PDF.'],
  ['text', '✍️ Lo escribo yo', 'Qué vendes y a qué precio, tu horario, dónde estás y lo que más te preguntan.'],
];
/** Lo mínimo para que pueda responder (el servidor aplica la misma regla). */
const MIN_INFO = 40;
const EMPTY_SECTIONS = { catalog: '', hours: '', location: '', faq: '', other: '' };
const FALLBACK = { scope: { role: 'assist', collect: ['nombre'], collect_other: '', prices: 'yes', unknown: 'confirm', forbidden: '', handoff_extra: '' }, style: { assistant_name: '', formality: 'tu', tone: 'cercano', emojis: 'few', length: 'corta' } };

const typeInfo = (key) => (state.meta.business_types || []).find((b) => b.key === key);
const typeDefaults = (key) => typeInfo(key)?.defaults || FALLBACK;
const copy = (o) => JSON.parse(JSON.stringify(o));
const newRequestId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`);
const infoChars = (w) => [w.company.description, w.knowledge.extra, ...Object.values(w.knowledge.sections)].join('').trim().length;
const importEndpoint = (w) => `/api/onboarding/import${isSuper() && w.account_id ? `?account_id=${encodeURIComponent(w.account_id)}` : ''}`;

/** Lo que se crea con el asistente. Lo que no se toca queda con lo que corresponde al tipo de negocio. */
function model() {
  const type = state.me.account?.business_type || 'otro';
  const d = typeDefaults(type);
  return draftModel('agent-new', {
    account_id: '',
    company: { name: state.me.account?.name || state.accounts.find((a) => a.id === state.accountId)?.name || '', business_type: type, description: '', location: '' },
    teach: { mode: 'url', url: '', text: '' },
    learned_from: '',
    truncated: false,
    knowledge: { sections: { ...EMPTY_SECTIONS }, extra: '', sources: [] },
    scope: copy(d.scope),
    style: copy(d.style),
    role_picked: false,
    personalized: false,
    prompt_override: null,
    request_id: '',
  });
}

/** Al cambiar el tipo de negocio, sus valores por omisión (salvo lo que la persona ya eligió). */
function applyTypeDefaults(w, type) {
  if (w.personalized) return;
  const d = typeDefaults(type);
  const role = w.role_picked ? w.scope.role : d.scope.role;
  const name = w.style.assistant_name;
  w.scope = { ...copy(d.scope), role };
  w.style = { ...copy(d.style), assistant_name: name };
}

/** Aviso temprano si el plan ya no permite más agentes (en lugar de fallar al final). */
function limitBanner() {
  const box = h('div');
  if (isSuper()) return box;
  api('GET', '/api/billing').then((b) => {
    const it = b.limits?.items?.find((i) => i.key === 'chatbots');
    if (it?.max && it.used >= it.max) fill(box, h('div', { class: 'banner warn' }, `Tu plan permite ${it.max} ${it.max === 1 ? 'agente' : 'agentes'} y ya los tienes. `, h('a', { href: '#/plan' }, 'Cambia de plan'), ' o edita uno de tus agentes.'));
  }).catch(() => undefined);
  return box;
}

const radioCard = (name, checked, onchange, title, help, extra) => h('label', { class: 'check plan-option' },
  h('input', { type: 'radio', name, checked, onchange }),
  h('span', {}, h('strong', {}, title), help ? h('div', { class: 'small muted' }, help) : null, extra || null));

/** Solo la primera vez que se abre en esta visita: así «retomamos» no aparece al ir y volver entre pantallas. */
let opened = false;

export async function viewNewAgent(root, params) {
  const w = model();
  const second = params.get('paso') === '2';
  // Sin información todavía, la pantalla 2 no tiene con qué trabajar.
  if (second && infoChars(w) < MIN_INFO) { location.replace('#/agentes/nuevo'); return; }
  const resumed = !opened && (!!w.learned_from || infoChars(w) > 0);
  opened = true;
  root.append(
    h('h1', {}, 'Crea tu agente'),
    stepsBar(second ? 1 : 0),
    resumed ? h('div', { class: 'banner', role: 'status' }, 'Retomamos lo que llevabas de tu agente. ',
      h('button', { class: 'small', onclick: () => { discardDraft('agent-new'); location.hash = '#/agentes/nuevo'; render(); } }, 'Empezar de nuevo')) : null,
    limitBanner(),
  );
  root.append(second ? screenRole(w) : screenBusiness(w));
}

/* ------------------------------ Pantalla 1: tu negocio y de dónde aprende ------------------------------ */

function screenBusiness(w) {
  let file = null;
  const fileName = h('span', { class: 'small muted' });
  const fileInput = h('input', { type: 'file', hidden: true, accept: IMPORT_ACCEPT, onchange: (e) => { file = e.target.files[0] || null; fileName.textContent = file ? `📎 ${file.name}` : ''; } });
  const sourceBox = h('div');
  const drawSource = () => fill(sourceBox,
    w.teach.mode === 'url' ? field('Dirección de tu página', text(w.teach, 'url', { type: 'url', placeholder: 'https://www.minegocio.com', autocomplete: 'url' })) : null,
    w.teach.mode === 'file' ? h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => fileInput.click() }, '📎 Elegir archivo'), fileInput, fileName) : null,
    w.teach.mode === 'text' ? field('Tu información', area(w.teach, 'text', { big: true, maxlength: 50000, placeholder: 'Ej.: Somos una clínica dental en Monterrey. Limpieza $600 (45 min), blanqueamiento $3,500. Abrimos de lunes a viernes de 9 a 7. Aceptamos tarjeta.' })) : null);
  drawSource();
  const status = h('p', { class: 'small muted', role: 'status' });
  const next = h('button', { class: 'primary', onclick: () => learn() }, 'Siguiente →');

  async function learn() {
    if (!w.company.name.trim()) return toast('Escribe el nombre de tu negocio', true);
    const mode = w.teach.mode;
    const source = mode === 'url' ? w.teach.url.trim() : mode === 'file' ? file : w.teach.text.trim();
    const signature = mode === 'file' ? (file ? `file:${file.name}:${file.size}` : '') : `${mode}:${source}`;
    const enough = mode === 'text' ? source.length >= 20 : !!source;
    if (!enough) {
      // Volvió de la pantalla 2 sin cambiar nada: ya aprendió lo necesario.
      if (infoChars(w) >= MIN_INFO && w.learned_from) { location.hash = '#/agentes/nuevo?paso=2'; return; }
      return toast(mode === 'url' ? 'Pega la dirección de tu página' : mode === 'file' ? 'Elige el archivo de tu negocio' : 'Cuéntale un poco más: al menos un par de frases sobre tu negocio', true);
    }
    if (signature === w.learned_from && infoChars(w) >= MIN_INFO) { location.hash = '#/agentes/nuevo?paso=2'; return; }
    next.disabled = true;
    status.textContent = 'Leyendo tu información… puede tardar hasta un minuto.';
    try {
      const r = await importFrom(importEndpoint(w), mode === 'file' ? { file } : mode === 'url' ? { url: source } : { text: source });
      w.knowledge = { sections: { ...EMPTY_SECTIONS, ...r.sections }, extra: '', sources: [r.source || 'tu información'] };
      if (r.description) w.company.description = r.description;
      w.truncated = !!r.truncated;
    } catch (e) {
      if (mode !== 'text') {
        status.textContent = '';
        next.disabled = false;
        return toast(`${e.message} Si prefieres, elige «Lo escribo yo» y pega tu información.`, true);
      }
      // No se pudo ordenar el texto (IA ocupada o sin saldo): se usa tal cual lo escribió.
      w.knowledge = { sections: { ...EMPTY_SECTIONS }, extra: source, sources: ['lo que escribiste'] };
      w.truncated = false;
    }
    w.learned_from = signature;
    next.disabled = false;
    status.textContent = '';
    if (infoChars(w) < MIN_INFO) return toast('Encontramos muy poca información de tu negocio. Prueba con otra fuente o escríbela tú.', true);
    w.prompt_override = null;
    location.hash = '#/agentes/nuevo?paso=2';
  }

  const types = (state.meta.business_types || []).map((b) => [b.key, b.label]);
  return h('div', { class: 'card stack wizard-step' },
    accountPicker(w),
    h('div', { class: 'grid' },
      field('Nombre de tu negocio', text(w.company, 'name', { placeholder: 'Clínica Sonrisa', maxlength: 120, autocomplete: 'organization' })),
      field('Tipo de negocio', select(w.company, 'business_type', types, (v) => applyTypeDefaults(w, v)))),
    h('fieldset', { class: 'field' },
      h('legend', {}, '¿De dónde aprende tu agente?'),
      h('p', { class: 'small muted', style: 'margin:0 0 8px' }, 'Solo responderá con lo que le enseñes; si algo no está, dirá que lo confirma con tu equipo.'),
      SOURCES.map(([mode, title, help]) => radioCard('teach-mode', w.teach.mode === mode, () => { w.teach.mode = mode; drawSource(); }, title, help)),
      sourceBox),
    h('div', { class: 'row between' }, status, next));
}

/* ------------------------------ Pantalla 2: qué hará (y personalizar, opcional) ------------------------------ */

function screenRole(w) {
  const suggested = typeDefaults(w.company.business_type).scope.role;
  const typeLabel = typeInfo(w.company.business_type)?.label || 'tu tipo de negocio';
  const chips = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
  const drawChips = () => fill(chips, Object.entries(SECTION_LABELS).map(([k, l]) => h('span', { class: 'chip' }, w.knowledge.sections[k].trim() ? `✓ ${l}` : `— ${l}`)),
    w.knowledge.extra.trim() ? h('span', { class: 'chip' }, '✓ Lo que escribiste') : null);
  drawChips();
  const sections = h('div', { class: 'stack' }, Object.entries(SECTION_LABELS).map(([k, l]) => field(l, area(w.knowledge.sections, k, { big: k === 'catalog', oninput: drawChips }))));
  const learned = h('div', { class: 'card stack' },
    h('h2', { style: 'margin:0' }, `Esto aprendió de ${w.company.name || 'tu negocio'}`),
    w.knowledge.sources.length ? h('p', { class: 'small muted', style: 'margin:0' }, `Leímos: ${w.knowledge.sources.join(' · ')}.${w.truncated ? ' Era muy largo: solo se leyó el inicio.' : ''}`) : null,
    field('Cómo se presenta tu negocio', area(w.company, 'description', { maxlength: 2000, placeholder: 'Clínica dental familiar en Monterrey: limpiezas, ortodoncia y blanqueamiento.' }), 'Una o dos frases.'),
    chips,
    h('details', {}, h('summary', {}, 'Revisar o corregir lo que aprendió'),
      sections,
      importCard({ endpoint: importEndpoint(w), title: 'Agregar otra fuente', button: 'Leer y agregar', intro: 'Lo que encontremos se agrega a lo que ya aprendió.', onResult: (r) => {
        for (const k of Object.keys(EMPTY_SECTIONS)) {
          const add = (r.sections?.[k] || '').trim();
          if (add) w.knowledge.sections[k] = [w.knowledge.sections[k].trim(), add].filter(Boolean).join('\n\n');
        }
        if (r.description && !w.company.description.trim()) w.company.description = r.description;
        w.knowledge.sources = [...w.knowledge.sources, r.source || 'documento'].slice(-10);
        w.prompt_override = null;
        toast('Listo: lo agregamos a lo que ya sabía');
        render();
      } }),
      field('Algo más que deba saber (opcional)', area(w.knowledge, 'extra', { maxlength: 20000, placeholder: 'Formas de pago, promociones vigentes, políticas…', oninput: drawChips }))));

  const roles = h('fieldset', { class: 'field card' },
    h('legend', {}, h('strong', {}, '¿Qué hará tu agente?')),
    ROLES.map(([v, title, help, example]) => radioCard('agent-role', w.scope.role === v, () => { w.scope.role = v; w.role_picked = true; },
      title, help, [
        v === suggested ? h('span', { class: 'badge green', style: 'margin-left:0' }, 'Recomendado para tu tipo de negocio') : null,
        h('div', { class: 'small muted', style: 'font-style:italic;margin-top:4px' }, example)])));

  const personal = h('details', { class: 'card' },
    h('summary', {}, h('strong', {}, 'Personalizar (opcional)'), h('span', { class: 'muted small' }, ` · Ya está ajustado para ${typeLabel.toLowerCase()}. Cámbialo solo si quieres.`)),
    h('h3', {}, 'Cómo habla'),
    h('div', { class: 'grid' },
      field('¿Con qué nombre se presenta? (opcional)', text(w.style, 'assistant_name', { placeholder: 'Sofi', maxlength: 60 }), 'Si lo dejas vacío, se presenta como el asistente de tu negocio.'),
      field('Trato', select(w.style, 'formality', [['tu', 'De tú'], ['usted', 'De usted']])),
      field('Tono', select(w.style, 'tone', [['cercano', 'Cercano'], ['profesional', 'Profesional']])),
      field('Emojis', select(w.style, 'emojis', [['few', 'Algunos'], ['none', 'Ninguno']])),
      field('Largo de las respuestas', select(w.style, 'length', [['muy_corta', 'Muy cortas'], ['corta', 'Cortas'], ['media', 'Medias']]))),
    h('h3', {}, 'Qué datos le pide al cliente'),
    h('div', { class: 'row', style: 'flex-wrap:wrap' }, COLLECT.map(([k, l]) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: w.scope.collect.includes(k), onchange: (e) => { w.scope.collect = e.target.checked ? [...w.scope.collect, k] : w.scope.collect.filter((x) => x !== k); } }), l))),
    field('Otros datos (uno por renglón)', area(w.scope, 'collect_other', { placeholder: 'Si es cliente nuevo\nMarca del auto' })),
    h('h3', {}, 'Límites'),
    h('div', { class: 'grid' },
      field('¿Puede dar precios?', select(w.scope, 'prices', [['yes', 'Sí, los que le enseñaste'], ['no', 'No: una persona cotiza']])),
      field('Si no sabe algo…', select(w.scope, 'unknown', [['confirm', 'Dice que lo confirmará con tu equipo'], ['handoff', 'Te pasa la conversación']]))),
    field('Temas que NO debe tocar (opcional, separados por coma)', text(w.scope, 'forbidden', { placeholder: 'diagnósticos médicos, política' })),
    field('Cuándo debe pasarte al cliente, además de lo normal (opcional)', area(w.scope, 'handoff_extra', { placeholder: 'Menciona una urgencia\nQuiere facturar' })),
    field('Dirección o zona del negocio (opcional)', text(w.company, 'location', { placeholder: 'Av. Juárez 123, Monterrey' })),
    promptDetails(w));
  // Cualquier cambio aquí cuenta como personalizado: cambiar el tipo de negocio ya no lo pisa.
  personal.addEventListener('change', () => { w.personalized = true; });
  personal.addEventListener('input', () => { w.personalized = true; });

  const errorBox = h('div');
  const create = h('button', { class: 'primary', onclick: async () => {
    if (!w.company.name.trim()) return toast('Escribe el nombre de tu negocio', true);
    if (infoChars(w) < MIN_INFO) return toast('Cuéntale un poco más de tu negocio en «Esto aprendió»: con tan poca información no podrá responder.', true);
    if (!w.request_id) w.request_id = newRequestId();
    create.disabled = true;
    fill(errorBox);
    try {
      const bot = await api('POST', '/api/chatbots/wizard', {
        company: w.company, scope: w.scope, style: w.style, knowledge: w.knowledge, request_id: w.request_id,
        ...(w.prompt_override ? { prompt_override: w.prompt_override } : {}),
        ...(isSuper() && w.account_id ? { account_id: w.account_id } : {}),
      });
      discardDraft('agent-new');
      state.bots = [];
      location.hash = `#/bot/${bot.id}/empezar`;
    } catch (e) {
      create.disabled = false;
      const limit = e.issues?.includes('limit_reached');
      fill(errorBox, h('div', { class: 'banner danger', role: 'alert' }, limit ? e.message.replace(/:.*$/, '') : e.message, limit ? [' ', h('a', { href: '#/plan' }, 'Ver planes')] : null));
      toast(limit ? 'Tu plan ya no permite más agentes' : e.message, true);
    }
  } }, 'Crear mi agente');

  return h('div', { class: 'stack' },
    learned,
    roles,
    personal,
    errorBox,
    h('p', { class: 'help', style: 'margin:0' }, 'Nace apagado: lo pruebas en el siguiente paso y se enciende solo cuando conectes tu WhatsApp.'),
    h('div', { class: 'row between' }, h('a', { class: 'btn', href: '#/agentes/nuevo' }, '← Atrás'), create));
}

/** Las instrucciones que se generarán (casi nadie las necesita: se piden solo al abrir). */
function promptDetails(w) {
  const box = h('div', {}, h('p', { class: 'muted small' }, 'Preparando…'));
  const load = async () => {
    try {
      const d = await api('POST', '/api/chatbots/draft', { company: w.company, scope: w.scope, style: w.style, knowledge: w.knowledge, ...(isSuper() && w.account_id ? { account_id: w.account_id } : {}) });
      const local = { v: w.prompt_override ?? d.prompt };
      fill(box,
        area(local, 'v', { big: true, 'aria-label': 'Instrucciones del agente', oninput: () => { w.prompt_override = local.v.trim() && local.v !== d.prompt ? local.v : null; } }),
        h('p', { class: 'small muted' }, 'Si las cambias aquí, se usan tal cual al crear el agente. Si después cambias otras opciones, vuelve a generarlas.'),
        h('button', { class: 'small', type: 'button', onclick: () => { w.prompt_override = null; load(); } }, 'Volver a generarlas'));
    } catch (e) { fill(box, h('p', { class: 'banner danger' }, e.message)); }
  };
  return h('details', { ontoggle: (e) => { if (e.currentTarget.open) load(); } }, h('summary', {}, 'Ver las instrucciones que se generarán'), box);
}
