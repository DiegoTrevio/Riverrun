import { importCard } from './importer.js';
import { api, area, check, field, fill, h, run, select, state, text, toast } from './core.js';
import { accountPicker } from './dashboard.js';
import { render } from './main.js';
import { withAcct } from './session.js';

/* ------------------------------ Asistente para crear un agente ------------------------------ */

const ROLES = [
  ['filter', 'Solo filtrar', 'Entiende qué necesita la persona, toma sus datos y la pasa a alguien de tu equipo. No cotiza ni cierra nada.'],
  ['book', 'Filtrar y agendar citas', 'Además ofrece los horarios libres de tu agenda y confirma la cita o llamada.'],
  ['assist', 'Atender y resolver dudas', 'Responde con la información de tu negocio y, si quieren avanzar, los pasa con tu equipo.'],
  ['sell', 'Atender y tomar pedidos', 'Resuelve dudas, toma el pedido completo y lo pasa a una persona para confirmarlo y cobrarlo.'],
];
const COLLECT = [['nombre', 'Nombre'], ['telefono', 'Teléfono'], ['correo', 'Correo'], ['ciudad', 'Ciudad o zona'], ['interes', 'Qué le interesa'], ['presupuesto', 'Presupuesto'], ['fecha', 'Fecha o momento'], ['personas', 'Número de personas']];
const SECTION_LABELS = { catalog: 'Productos o servicios con precios', hours: 'Horarios', location: 'Ubicación y contacto', faq: 'Preguntas frecuentes', other: 'Otra información' };
const STEPS = ['Tu empresa', 'Hasta dónde llega', 'Documentos', 'Revisar y crear'];

export function agentWizard({ hidden }) {
  const w = {
    account_id: '',
    company: { name: '', business_type: state.me.account?.business_type || 'otro', description: '', location: '' },
    scope: { role: 'assist', collect: ['nombre'], collect_other: '', prices: 'yes', unknown: 'confirm', forbidden: '', handoff_extra: '' },
    style: { assistant_name: '', formality: 'tu', tone: 'cercano', emojis: 'few', length: 'corta' },
    knowledge: { sections: { catalog: '', hours: '', location: '', faq: '', other: '' }, extra: '', sources: [] },
  };
  let step = 0;
  let draft = null;
  let editedPrompt = null;
  const box = h('div', { class: 'card', hidden });
  const body = h('div');
  const body2 = () => ({ ...w, account_id: undefined, ...(editedPrompt ? { prompt_override: editedPrompt } : {}) });

  const radio = (obj, key, value, label, help) => h('label', { class: 'check', style: 'align-items:flex-start;margin:6px 0' },
    h('input', { type: 'radio', name: `wz-${key}`, checked: obj[key] === value, onchange: () => { obj[key] = value; } }),
    h('span', {}, h('strong', {}, label), help ? h('div', { class: 'small muted' }, help) : null));

  const stepper = () => h('div', { class: 'tabs' }, STEPS.map((s, i) => h('a', { class: i === step ? 'active' : '', href: '#', onclick: (e) => { e.preventDefault(); if (i < step) go(i); } }, `${i + 1}. ${s}`)));

  const sources = h('div');
  const drawSources = () => fill(sources, w.knowledge.sources.length
    ? h('div', { class: 'banner' }, '✓ Leímos: ', w.knowledge.sources.join(' · '), '. Puedes revisar y corregir lo que encontramos abajo.')
    : null);

  function mergeImport(r) {
    for (const k of Object.keys(w.knowledge.sections)) {
      const add = (r.sections?.[k] || '').trim();
      if (add) w.knowledge.sections[k] = [w.knowledge.sections[k].trim(), add].filter(Boolean).join('\n\n');
    }
    if (r.description && !w.company.description.trim()) w.company.description = r.description;
    w.knowledge.sources.push(r.source || 'documento');
    editedPrompt = null;
    go(2);
  }

  const views = [
    () => [
      h('p', { class: 'muted' }, 'Cuéntanos de tu empresa. Con esto armamos las instrucciones de tu agente: tú no tienes que escribir ningún prompt.'),
      accountPicker(w),
      h('div', { class: 'grid' },
        field('Nombre de tu empresa', text(w.company, 'name', { placeholder: 'Clínica Sonrisa', maxlength: 120 })),
        field('Tipo de negocio', select(w.company, 'business_type', (state.meta.business_types || []).map((b) => [b.key, b.label])))),
      field('¿A qué se dedica?', area(w.company, 'description', { placeholder: 'Clínica dental familiar en Monterrey: limpiezas, ortodoncia y blanqueamiento.', maxlength: 2000 }), 'Una o dos frases. Así se presentará tu agente.'),
      field('Dirección o zona (opcional)', text(w.company, 'location', { placeholder: 'Av. Juárez 123, Monterrey' })),
      field('Nombre del agente (opcional)', text(w.style, 'assistant_name', { placeholder: 'Sofi' }), 'Si le pones nombre, se presenta con él.'),
    ],
    () => [
      h('h4', { style: 'margin-top:0' }, '¿Cuál será su trabajo?'),
      ROLES.map(([v, l, d]) => radio(w.scope, 'role', v, l, d)),
      h('h4', {}, '¿Qué datos debe pedir al cliente?'),
      h('div', { class: 'row' }, COLLECT.map(([k, l]) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: w.scope.collect.includes(k), onchange: (e) => { w.scope.collect = e.target.checked ? [...w.scope.collect, k] : w.scope.collect.filter((x) => x !== k); } }), l))),
      field('Otros datos (uno por renglón)', area(w.scope, 'collect_other', { placeholder: 'Si es paciente nuevo\nMarca del auto' })),
      h('h4', {}, 'Límites'),
      h('div', { class: 'grid' },
        field('¿Puede dar precios?', select(w.scope, 'prices', [['yes', 'Sí, los que estén en tus documentos'], ['no', 'No: una persona cotiza']])),
        field('Si no sabe algo…', select(w.scope, 'unknown', [['confirm', 'Dice que lo confirmará con el equipo'], ['handoff', 'Pasa la conversación a una persona']]))),
      field('Temas que NO debe tocar (opcional, separados por coma)', text(w.scope, 'forbidden', { placeholder: 'diagnósticos médicos, política' })),
      field('Otras situaciones en las que debe pasar con una persona (opcional)', area(w.scope, 'handoff_extra', { placeholder: 'Menciona una urgencia\nQuiere facturar' })),
      h('h4', {}, 'Cómo debe sonar'),
      h('div', { class: 'grid' },
        field('Trato', select(w.style, 'formality', [['tu', 'De tú'], ['usted', 'De usted']])),
        field('Tono', select(w.style, 'tone', [['cercano', 'Cercano'], ['profesional', 'Profesional']])),
        field('Emojis', select(w.style, 'emojis', [['few', 'Algunos'], ['none', 'Ninguno']])),
        field('Largo de las respuestas', select(w.style, 'length', [['muy_corta', 'Muy cortas'], ['corta', 'Cortas'], ['media', 'Medias']]))),
      h('p', { class: 'small muted' }, 'Siempre: suena natural, contesta solo lo que le preguntan, no inventa datos y no se sale de su papel aunque el cliente se lo pida.'),
    ],
    () => [
      h('p', { class: 'muted' }, 'Sube lo que tengas para que el agente aprenda de tu empresa: tu página web, un PDF, una lista de precios, el menú (foto o PDF) o una hoja de cálculo. Puedes agregar varios, uno por vez.'),
      sources,
      importCard({ endpoint: withAcct('/api/onboarding/import'), title: '📄 Aprender de mis documentos', button: 'Leer documento', onResult: mergeImport }),
      Object.keys(SECTION_LABELS).some((k) => w.knowledge.sections[k].trim())
        ? h('details', { open: true }, h('summary', {}, 'Lo que aprendió (revísalo y corrige lo que haga falta)'),
          Object.entries(SECTION_LABELS).map(([k, l]) => field(l, area(w.knowledge.sections, k, { big: k === 'catalog' }))))
        : null,
      field('O escribe aquí información extra (opcional)', area(w.knowledge, 'extra', { placeholder: 'Formas de pago, promociones vigentes, políticas…', maxlength: 20000 })),
    ],
    () => {
      const out = h('div', {}, h('p', { class: 'muted' }, 'Preparando tu agente…'));
      api('POST', '/api/chatbots/draft', { ...body2(), account_id: w.account_id || undefined }).then((d) => {
        draft = d;
        const prompt = { v: editedPrompt ?? d.prompt };
        fill(out,
          h('div', { class: 'banner' }, `Se creará "${d.name}". Objetivo: ${d.goal}.`),
          h('p', { class: 'small' }, '📚 Aprenderá de: ', d.knowledge.map((k) => `${k.title} (${k.chars.toLocaleString('es-MX')} caracteres)`).join(' · ')),
          d.creates_service ? h('p', { class: 'small' }, `📅 También se creará el servicio de agenda "${d.creates_service}" (30 minutos) en tus horarios para que pueda agendar.`) : null,
          h('details', {}, h('summary', {}, 'Ver (y ajustar, si quieres) las instrucciones que se generaron'),
            area(prompt, 'v', { big: true }),
            h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => { editedPrompt = prompt.v === d.prompt ? null : prompt.v; toast(editedPrompt ? 'Usaremos tu versión de las instrucciones' : 'Sin cambios'); } }, 'Usar mi versión'),
              h('button', { class: 'small', onclick: () => { editedPrompt = null; go(3); } }, 'Volver a generarlas'))),
          h('p', { class: 'help' }, 'Se crea apagado para que lo pruebes antes de conectarlo a un teléfono.'));
      }).catch((e) => fill(out, h('div', { class: 'banner danger' }, e.message)));
      return [out];
    },
  ];

  function validate(i) {
    if (i === 0 && !w.company.name.trim()) return 'Escribe el nombre de tu empresa';
    if (i === 0 && w.company.description.trim().length < 15) return 'Cuéntanos en una frase a qué se dedica tu empresa';
    return '';
  }

  function go(i) {
    step = i;
    draw();
  }

  function draw() {
    drawSources();
    fill(body, stepper(), h('div', { class: 'stack' }, views[step]()),
      h('div', { class: 'row between', style: 'margin-top:12px' },
        step > 0 ? h('button', { onclick: () => go(step - 1) }, '← Atrás') : h('span'),
        step < STEPS.length - 1
          ? h('button', { class: 'primary', onclick: () => { const e = validate(step); if (e) return toast(e, true); go(step + 1); } }, step === 2 ? 'Continuar sin más documentos →' : 'Siguiente →')
          : h('button', { class: 'primary', onclick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              try {
                const bot = await run(() => api('POST', '/api/chatbots/wizard', { ...body2(), account_id: w.account_id || undefined }));
                if (bot) { state.bots = []; location.hash = `#/bot/${bot.id}/probar`; render(); }
              } finally { btn.disabled = false; }
            } }, 'Crear mi agente y probarlo')));
  }

  fill(box, h('h3', { style: 'margin-top:0' }, 'Crea tu agente'), body);
  draw();
  return box;
}
