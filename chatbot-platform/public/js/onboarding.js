import { hoursEditor } from './automation.js';
import { tabImages } from './bot.js';
import { api, area, clone, field, fill, h, run, select, state, text, toast } from './core.js';
import { importCard } from './importer.js';
import { render } from './main.js';
import { tabPlayground } from './playground.js';
import { metaConnectButton } from './meta.js';
import { isSuper, withAcct } from './session.js';
import { whatsappConnector } from './whatsapp.js';

/* ------------------------------ Primeros pasos (asistente de configuración) ------------------------------ */

const ONB_STEPS = [
  ['negocio', 'business', 'Tu negocio'],
  ['asistente', 'assistant', 'Tu asistente'],
  ['prueba', 'test', 'Pruébalo'],
  ['redes', 'networks', 'Redes (opcional)'],
  ['whatsapp', 'whatsapp', 'WhatsApp'],
];

const TIMEZONES = [
  ['America/Mexico_City', 'México (Centro)'], ['America/Monterrey', 'México (Monterrey)'], ['America/Cancun', 'México (Cancún)'],
  ['America/Chihuahua', 'México (Chihuahua)'], ['America/Mazatlan', 'México (Pacífico)'], ['America/Tijuana', 'México (Tijuana)'],
  ['America/Bogota', 'Colombia'], ['America/Lima', 'Perú'], ['America/Santiago', 'Chile'], ['America/Argentina/Buenos_Aires', 'Argentina'],
  ['America/Guatemala', 'Guatemala / Centroamérica'], ['America/Panama', 'Panamá'], ['America/Caracas', 'Venezuela'],
  ['America/Santo_Domingo', 'República Dominicana'], ['America/New_York', 'EUA (Este)'], ['America/Chicago', 'EUA (Centro)'],
  ['America/Los_Angeles', 'EUA (Pacífico)'], ['Europe/Madrid', 'España'],
];

export async function viewOnboarding(root, stepKey) {
  const ob = await api('GET', withAcct('/api/onboarding'));
  if (state.me.account && ob.complete && !state.me.account.onboarding?.done) state.me.account.onboarding = { ...state.me.account.onboarding, done: true };
  const firstPending = ONB_STEPS.find(([, k]) => !ob.steps[k]);
  const current = ONB_STEPS.find(([slug]) => slug === stepKey) || (ob.complete ? null : firstPending) || null;
  const go = (slug) => { location.hash = `#/inicio/${slug}`; };
  const next = (slug) => { const i = ONB_STEPS.findIndex(([s]) => s === slug); state.me = null; go(ONB_STEPS[i + 1]?.[0] || ''); };

  root.append(
    h('h1', {}, ob.complete ? '¡Tu asistente está listo! 🎉' : `Configura tu asistente`),
    !ob.chatbot_id ? h('p', {}, h('a', { class: 'btn primary', href: '#/asistentes?new=1' }, 'Crear mi agente con el asistente')) : null,
    h('ol', { class: 'steps' }, ONB_STEPS.map(([slug, k, label], i) =>
      h('li', { class: `${ob.steps[k] ? 'done' : ''} ${current?.[0] === slug ? 'current' : ''}` },
        h('a', { href: `#/inicio/${slug}` }, h('span', { class: 'num' }, ob.steps[k] ? '✓' : i + 1), label)))),
  );
  const box = h('div');
  root.append(box);
  if (!current) return onbDone(box, ob);
  const [slug] = current;
  if (slug === 'negocio') return onbBusiness(box, ob, () => next(slug));
  if (slug === 'asistente') return onbAssistant(box, ob, () => next(slug));
  if (!ob.chatbot_id) return box.append(h('div', { class: 'card' }, h('p', {}, 'Primero configura tu asistente.'), h('a', { class: 'btn primary', href: '#/inicio/asistente' }, 'Ir al paso 2')));
  const bot = await api('GET', `/api/chatbots/${ob.chatbot_id}`);
  if (slug === 'prueba') {
    box.append(h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Pruébalo como si fueras un cliente'),
      h('p', { class: 'muted' }, 'Pregunta precios, horarios o pide algo que no esté en tu información: debe decir que lo confirma con el equipo en lugar de inventar. Si algo no te gusta, regresa al paso 2 y ajusta la información.')));
    const pg = h('div');
    const photos = h('div');
    box.append(pg,
      h('details', { class: 'card', style: 'margin-top:12px' },
        h('summary', {}, '📷 Agregar fotos de tus productos o instalaciones (opcional)'),
        h('p', { class: 'muted' }, 'El asistente solo envía fotos de este catálogo y elige la correcta según lo que pregunte el cliente. Describe cada foto (qué es, precio si aplica). Puedes hacerlo después en Mi asistente → Fotos.'),
        photos),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'primary', onclick: async () => { if (!(await run(() => api('POST', withAcct('/api/onboarding/step'), { step: 'test' })))) return; next(slug); } }, 'Me gusta, continuar'),
        h('a', { class: 'btn', href: '#/inicio/asistente' }, 'Ajustar información')));
    tabImages(photos, bot);
    return tabPlayground(pg, bot);
  }
  if (slug === 'redes') return onbNetworks(box, ob, bot, () => next(slug));
  if (slug === 'whatsapp') return onbWhatsapp(box, ob, bot);
}

/** Paso opcional: Facebook e Instagram con un botón y las demás redes (Zernio) una por una. Se puede omitir. */
async function onbNetworks(box, ob, bot, done) {
  const metaDirect = !!state.meta.meta_connect_enabled;
  const networks = state.meta.zernio_enabled ? (state.meta.social_networks || []).filter((n) => !(metaDirect && ['facebook', 'instagram'].includes(n.id))) : [];
  const channels = (await api('GET', `/api/channels${isSuper() ? `?account_id=${bot.account_id}` : ''}`)).filter((c) => c.account_id === bot.account_id && ['messenger', 'instagram', 'zernio'].includes(c.type));
  const finish = async () => { if (await run(() => api('POST', withAcct('/api/onboarding/step'), { step: 'networks' }))) done(); };
  const connectNetwork = (n) => h('button', { onclick: async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      // La red se autoriza en su ficha; al volver, la conexión ya responde con el asistente.
      const created = await run(() => api('POST', '/api/channels', { type: 'zernio', config: { platform: n.id }, name: n.label, chatbot_id: bot.id, ...(isSuper() ? { account_id: bot.account_id } : {}) }));
      if (created) location.hash = `#/bot/${bot.id}/conexiones/${created.id}`;
    } finally { button.disabled = false; }
  } }, n.label);
  if (!ob.email_verified) {
    box.append(h('div', { class: 'card' }, h('p', {}, `Confirma tu correo (${state.me.user.email}) para conectar redes. Puedes hacerlo después desde Conexiones.`), h('button', { class: 'primary', onclick: finish }, 'Omitir por ahora')));
    return;
  }
  box.append(h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Conecta tus redes sociales'),
    h('p', { class: 'muted' }, 'Los mensajes directos de tus redes llegan a las mismas conversaciones y ', bot.personality?.assistant_name || 'tu asistente', ' los contesta. Es opcional: puedes hacerlo después desde Conexiones.'),
    channels.length ? h('ul', {}, channels.map((c) => h('li', {}, c.name, ' ', h('span', { class: `badge ${c.connection_state === 'close' ? 'red' : 'green'}` }, c.connection_state === 'close' ? 'Desconectado' : 'Conectado')))) : null,
    metaDirect ? h('div', { class: 'list-item' },
      h('h3', { style: 'margin:0' }, '💬📸 Facebook e Instagram'),
      h('p', { class: 'help' }, 'Inicia sesión con Facebook y elige tus páginas y tu Instagram profesional.'),
      metaConnectButton({ chatbotId: bot.id, accountId: bot.account_id })) : null,
    networks.length ? h('div', { class: 'list-item' },
      h('h3', { style: 'margin:0' }, 'Otras redes'),
      h('div', { class: 'row' }, networks.map(connectNetwork))) : null,
    !metaDirect && !networks.length ? h('p', { class: 'help' }, 'Las redes sociales todavía no están activadas en esta plataforma.') : null,
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'primary', onclick: finish }, channels.length ? 'Continuar' : 'Omitir por ahora'))));
}

function onbBusiness(box, ob, done) {
  const f = { business_type: state.me.account?.business_type || 'otro', timezone: ob.business.timezone, business_hours: clone(ob.business.business_hours), alert_phone: ob.business.alert_phone };
  box.append(h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Datos de tu negocio'),
    h('div', { class: 'grid' },
      field('Tipo de negocio', select(f, 'business_type', ob.business_types.map((b) => [b.key, b.label])), 'Con esto preparamos a tu asistente: cómo atiende, qué datos pide y qué no debe decir.'),
      field('Zona horaria', select(f, 'timezone', TIMEZONES.some(([z]) => z === f.timezone) ? TIMEZONES : [[f.timezone, f.timezone], ...TIMEZONES])),
      field('Tu WhatsApp para avisos', text(f, 'alert_phone', { placeholder: '5215512345678' }), 'Con lada de país. Te avisamos ahí cuando un cliente pida hablar con una persona.')),
    h('h3', {}, 'Horario de atención'),
    h('p', { class: 'small muted' }, 'Por día: 09:00-14:00, 16:00-19:00 (vacío = cerrado). Se usa para agendar citas y para los mensajes fuera de horario.'),
    hoursEditor(f.business_hours),
    h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', withAcct('/api/onboarding/business'), f), 'Guardado')) done(); } }, 'Guardar y continuar')));
}

function onbAssistant(box, ob, done) {
  const a = ob.assistant || { assistant_name: '', formality: '', knowledge: {} };
  // Sin bot todavía, el trato lo decide la plantilla del giro (p.ej. "usted" en salud).
  const f = { assistant_name: a.assistant_name || '', formality: ob.assistant ? a.formality : '', description: '', knowledge: { catalog: '', hours: '', location: '', faq: '', other: '', ...a.knowledge } };
  const k = f.knowledge;
  const hasInfo = () => Object.values(k).some((v) => v && v.trim());
  let imported = null;
  const draw = () => fill(box,
    importCard({
      endpoint: withAcct('/api/onboarding/import'),
      title: hasInfo() ? '⚡ Leer otra fuente' : '⚡ Lo más rápido: llena todo por mí',
      onResult: (data) => {
        imported = data;
        if (data.description && !f.description.trim()) f.description = data.description;
        for (const key of Object.keys(k)) if (data.sections[key]) k[key] = data.sections[key];
        toast('Listo: revisa lo que encontramos y corrige lo que haga falta');
        draw();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    }),
    imported ? h('div', { class: 'banner' }, `Leímos ${imported.source}. Revisa abajo: es lo único que tu asistente podrá afirmar.${imported.truncated ? ' (La fuente era muy larga: solo se leyó el inicio.)' : ''}`) : null,
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Lo que tu asistente sabe'),
      h('p', { class: 'muted' }, 'Tu asistente responde únicamente con esta información: si un precio o dato no está aquí, dirá que lo confirma con tu equipo. Escribe como se lo explicarías a un empleado nuevo.'),
      h('div', { class: 'grid' },
        field('Nombre del asistente (opcional)', text(f, 'assistant_name', { placeholder: 'Sofi' })),
        field('Cómo trata a tus clientes', select(f, 'formality', [...(f.formality ? [] : [['', 'Lo usual en tu tipo de negocio']]), ['tu', 'De tú'], ['usted', 'De usted']]))),
      field('Describe tu negocio en una o dos frases', area(f, 'description', { placeholder: 'Clínica dental familiar en el centro de Monterrey, con 15 años de experiencia.' })),
      field('Productos o servicios con precios *', area(k, 'catalog', { big: true, placeholder: 'Limpieza dental — $600 (45 min)\nResina — desde $900\nBlanqueamiento — $3,500\nConsulta de valoración — gratis' }), 'Uno por renglón. Incluye precios, duración, tamaños o lo que te pregunten.'),
      h('div', { class: 'grid' },
        field('Detalles de horario (opcional)', area(k, 'hours', { placeholder: 'Último turno a las 18:30\nDías festivos cerramos' }), 'Tu horario de atención del paso 1 ya lo conoce; aquí van solo detalles extra.'),
        field('Ubicación y contacto', area(k, 'location', { placeholder: 'Av. Constitución 100, Centro, Monterrey\nEstacionamiento gratis\nTel. 81 1234 5678' }))),
      field('Preguntas frecuentes', area(k, 'faq', { big: true, placeholder: '¿Aceptan tarjeta? Sí, todas las tarjetas y transferencia.\n¿Hay estacionamiento? Sí, gratuito.' })),
      field('Otra información (promociones, políticas, formas de pago…)', area(k, 'other')),
      h('button', { class: 'primary', onclick: async () => {
        if (!k.catalog.trim()) return toast('Escribe al menos tus productos o servicios', true);
        if (await run(() => api('POST', withAcct('/api/onboarding/assistant'), { ...f, formality: f.formality || undefined }), 'Asistente listo')) done();
      } }, 'Guardar y continuar'),
      ob.chatbot_id ? h('p', { class: 'small muted' }, 'Para cambiar cómo atiende y qué pregunta entra a ', h('a', { href: `#/bot/${ob.chatbot_id}/personalidad` }, 'la configuración avanzada'), '.') : null));
  draw();
}

function onbWhatsapp(box, ob, bot) {
  if (!ob.email_verified) {
    return box.append(h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Confirma tu correo para conectar WhatsApp'),
      h('p', {}, `Te enviamos un enlace a ${state.me.user.email}. Ábrelo y vuelve aquí.`),
      h('div', { class: 'row' },
        h('button', { onclick: () => run(() => api('POST', '/api/me/resend-verification'), 'Te enviamos un nuevo enlace') }, 'Reenviar correo'),
        h('button', { onclick: () => { state.me = null; render(); } }, 'Ya lo confirmé'))));
  }
  const area = h('div', {}, h('p', { class: 'muted' }, 'Preparando tu conexión…'));
  box.append(h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Conecta el WhatsApp de tu negocio'),
    h('p', { class: 'muted' }, 'Puede ser WhatsApp normal o WhatsApp Business. Sigues usando WhatsApp en tu teléfono como siempre; si contestas tú, ',
      bot.personality?.assistant_name || 'tu asistente', ' se pausa en esa conversación.'),
    area));
  // El canal se crea solo al entrar al paso; el código aparece sin más clics.
  api('POST', withAcct('/api/onboarding/whatsapp'))
    .then((ch) => fill(area, whatsappConnector(ch.id, { onConnected: () => { state.me = null; setTimeout(() => { location.hash = '#/inicio'; render(); }, 2500); } })))
    .catch((e) => fill(area, h('p', { class: 'banner danger' }, e.message), h('button', { onclick: () => render() }, 'Reintentar')));
}

function onbDone(box, ob) {
  box.append(h('div', { class: 'card' },
    h('p', {}, 'Tu asistente está conectado y respondiendo. Esto es lo que puedes hacer ahora:'),
    h('ul', {},
      h('li', {}, h('a', { href: '#/conversations' }, 'Ver las conversaciones'), ' y tomar el control cuando quieras.'),
      ob.chatbot_id ? h('li', {}, h('a', { href: `#/bot/${ob.chatbot_id}/conocimiento` }, 'Agregar más información'), ' o ', h('a', { href: `#/bot/${ob.chatbot_id}/imagenes` }, 'más fotos'), '.') : null,
      h('li', {}, h('a', { href: '#/agenda/servicios' }, 'Configurar tu agenda'), ' para que agende citas solo.'),
      h('li', {}, h('a', { href: '#/inicio/redes' }, 'Conectar Facebook, Instagram y otras redes'), '.'),
      h('li', {}, h('a', { href: '#/automation' }, 'Crear respuestas automáticas y recordatorios'), '.'),
      h('li', {}, h('a', { href: '#/users' }, 'Invitar a tu equipo'), '.'))));
}
