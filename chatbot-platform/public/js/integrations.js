import { api, dialog, field, fmtDate, h, run, text, toast, confirmAction, ask } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';

/* ------------------------------ Integraciones ------------------------------ */

const acctBody = (b = {}) => ({ ...b, ...Object.fromEntries(new URLSearchParams(withAcct('?').slice(1))) });

const copyButton = (value, label = 'Copiar', what = '') => h('button', { class: 'small', 'aria-label': what ? `Copiar ${what}` : undefined, onclick: async () => { try { await navigator.clipboard.writeText(value); toast('Copiado'); } catch { toast('No se pudo copiar: selecciónalo y cópialo a mano', true); } } }, label);
/** Un bloque de código con su botón de copiar (se desplaza con el teclado si no cabe). */
const codeBlock = (code, what) => h('div', { class: 'code-block' }, h('pre', { tabindex: 0, 'aria-label': what }, code), copyButton(code, 'Copiar', what));

/** Calendarios que se pueden conectar: las citas se copian ahí y sus horarios ocupados no se ofrecen. */
const CALENDARS = {
  google: { name: 'Google Calendar', env: 'GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET', disconnectNote: 'Los eventos ya creados se quedan en tu calendario.' },
  outlook: { name: 'Outlook', env: 'MICROSOFT_CLIENT_ID y MICROSOFT_CLIENT_SECRET', disconnectNote: 'Los eventos ya creados se quedan en tu calendario. Para retirar el permiso por completo, hazlo también en tu cuenta de Microsoft (Aplicaciones y servicios).', hint: 'Microsoft 365 (cuentas de trabajo) u Outlook.com / Hotmail.' },
};

async function calendarCard(params, key) {
  const c = CALENDARS[key];
  const g = await api('GET', withAcct(`/api/integrations/${key}`));
  const flash = params.get(key);
  const note = { ok: [`${c.name} quedó conectado.`, false], cancelado: [`Cancelaste la conexión con ${c.name}.`, false], error: [params.get('msg') || `No se pudo conectar con ${c.name}.`, true] }[flash];
  if (note) toast(note[0], note[1]);
  const body = !g.available
    ? [h('p', { class: 'muted' }, `Esta instalación todavía no tiene ${c.name} configurado. Quien administra el servidor debe definir ${c.env} (ver docs/integraciones.md).`)]
    : g.connected
      ? [
          h('p', {}, `Conectado${g.email ? ` como ${g.email}` : ''}. Cada cita que se agende, cambie o cancele aparece en tu calendario.`),
          g.last_error ? h('p', { class: 'badge red' }, `Último error: ${g.last_error}`) : null,
          h('p', { class: 'muted small' }, g.block_busy ? `Los horarios en que estás ocupado en ${c.name} no se ofrecen a los clientes.` : `Los horarios ocupados en ${c.name} no se bloquean.`),
          h('div', { class: 'row' },
            h('button', { onclick: async () => { const v = !g.block_busy; if (!(await run(() => api('PUT', `/api/integrations/${key}`, acctBody({ block_busy: v })), 'Guardado'))) return; render(); } }, g.block_busy ? 'Dejar de bloquear horarios ocupados' : 'Bloquear horarios ocupados'),
            h('button', { class: 'danger', onclick: async () => { if (await confirmAction(`¿Desconectar ${c.name}? ${c.disconnectNote}`)) { if (!(await run(() => api('DELETE', withAcct(`/api/integrations/${key}`)), 'Desconectado'))) return; render(); } } }, 'Desconectar')),
        ]
      : [
          h('p', { class: 'muted' }, `Copia tus citas a ${c.name} y evita que el asistente ofrezca horas en las que ya estás ocupado.${c.hint ? ` ${c.hint}` : ''}`),
          h('button', { class: 'primary', onclick: async () => { const r = await run(() => api('POST', `/api/integrations/${key}/connect`, acctBody())); if (r) location.href = r.url; } }, `Conectar ${c.name}`),
        ];
  return h('div', { class: 'card' }, h('h2', {}, c.name), ...body);
}

/* ------------------------------ Conecta tu sistema (API) ------------------------------ */

/** Los pasos para conectar tu CRM o tu tienda, con ejemplos que ya traen tu dirección, tu canal y tus datos. */
function connectCard({ channels, fields, keys }) {
  const base = `${location.origin}/api/v1`;
  const whatsapp = channels.filter((c) => c.type === 'whatsapp' && c.active);
  // Con un solo WhatsApp no hace falta channel_id; con varios, los ejemplos usan el primero.
  const channelPart = whatsapp.length > 1 ? `"channel_id": "${whatsapp[0].id}", ` : '';
  // Un valor que la API acepta para el primer dato definido (copiado tal cual, funciona).
  const SAMPLE_VALUE = { number: 1, date: '1990-11-03', email: 'ana@ejemplo.com', phone: '+52 55 1234 5678', text: 'Ejemplo' };
  const sample = fields[0] ? `${JSON.stringify(fields[0].key)}: ${JSON.stringify(fields[0].type === 'option' ? fields[0].options[0] ?? '' : SAMPLE_VALUE[fields[0].type] ?? 'Ejemplo')}`.replaceAll("'", "\\u0027") : '"correo": "ana@ejemplo.com"';
  const post = (path, body, idem) => `curl -X POST ${base}${path} \\\n  -H "Authorization: Bearer TU_LLAVE" \\\n  -H "Content-Type: application/json" \\\n${idem ? `  -H "Idempotency-Key: ${idem}" \\\n` : ''}  -d '${body}'`;
  const examples = [
    ['Dar de alta (o actualizar) un cliente', post('/contacts', `{ ${channelPart}"phone": "+52 55 1234 5678", "name": "Ana López", "data": { ${sample} }, "tags": ["crm"] }`, 'cliente-1024'), 'El teléfono puede ir en cualquier formato. Si ya existe, se actualiza (no se duplica).'],
    ['Enviar un mensaje', post('/messages', `{ ${channelPart}"phone": "+52 55 1234 5678", "text": "Hola Ana, tu pedido va en camino" }`, 'pedido-551-enviado'), 'Respeta a quien se dio de baja y la ventana de 24 h de WhatsApp.'],
    ['Registrar un cobro con recordatorios', post('/receivables', `{ ${channelPart}"phone": "+52 55 1234 5678", "concept": "Mensualidad de noviembre", "amount_cents": 150000, "due_date": "2026-11-05" }`, 'factura-F1024'), 'Los recordatorios por WhatsApp salen solos antes y después del vencimiento.'],
    ['Leer los clientes que cambiaron', `curl "${base}/contacts?updated_since=2026-10-01T00:00:00Z&limit=100" \\\n  -H "Authorization: Bearer TU_LLAVE"`, 'Si hay más, la respuesta trae next_cursor para pedir la siguiente página.'],
  ];
  const writeKey = keys.some((k) => !k.revoked_at && k.scope === 'write');
  return h('section', { class: 'card', 'aria-labelledby': 'connect-title' },
    h('h2', { id: 'connect-title' }, 'Conecta tu sistema'),
    h('p', { class: 'muted' }, 'Tu CRM, tu tienda, Zapier, Make o n8n: con la API das de alta clientes, cobros y mensajes; con los webhooks (abajo) te avisamos cuando pasa algo.'),
    h('ol', { class: 'connect-steps' },
      h('li', {}, h('strong', {}, 'Crea una llave '), writeKey ? 'Ya tienes una de lectura y escritura (en «Llaves de la API», abajo).' : 'en «Llaves de la API» (abajo). Elige «Lectura y escritura» si tu sistema va a dar de alta clientes o enviar mensajes.'),
      h('li', {}, h('strong', {}, 'Pon en tu sistema esta dirección y tu llave'), h('div', { class: 'row' }, h('code', { class: 'code-inline' }, base), copyButton(base, 'Copiar', 'la dirección de la API'))),
      h('li', {}, h('strong', {}, 'Prueba la conexión'), ' (responde con el nombre de tu cuenta):', codeBlock(`curl ${base}/me -H "Authorization: Bearer TU_LLAVE"`, 'el comando de prueba'))),
    h('details', {}, h('summary', {}, 'Ejemplos listos para copiar'),
      examples.map(([title, code, note]) => h('div', { class: 'example' }, h('h3', {}, title), codeBlock(code, title.toLowerCase()), h('p', { class: 'muted small' }, note))),
      h('p', { class: 'muted small' }, 'Idempotency-Key es opcional: si tu sistema repite la petición (se cortó la red), recibe la misma respuesta sin crear otro cliente ni enviar el mensaje otra vez.')),
    h('details', {}, h('summary', {}, `Claves de los datos de tus clientes (${fields.length})`),
      fields.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Clave en data'), h('th', {}, 'Dato'), h('th', {}, 'Acepta'))),
          h('tbody', {}, fields.map((f) => h('tr', {}, h('td', {}, h('code', {}, f.key)), h('td', {}, f.label), h('td', {}, f.type === 'option' ? `Una de: ${f.options.join(', ')}` : { text: 'Texto', number: 'Número', date: 'Fecha (AAAA-MM-DD o DD/MM/AAAA)', email: 'Correo', phone: 'Teléfono' }[f.type] ?? f.type)))))
        : h('p', { class: 'muted' }, 'Todavía no defines datos de tus clientes; puedes mandar los que quieras en data. Defínelos en «Datos de clientes» para que se validen.'),
      whatsapp.length > 1 ? h('p', { class: 'muted small' }, `Tienes ${whatsapp.length} WhatsApp: indica channel_id (${whatsapp.map((c) => `${c.name}: ${c.id}`).join(' · ')}).`) : null),
    h('p', {}, h('a', { href: '/api/v1/docs', target: '_blank', rel: 'noopener' }, 'Documentación completa de la API'), ' · ', h('a', { href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener' }, 'Especificación OpenAPI (Postman, Insomnia)')));
}

/** El secreto con el que se firman los webhooks, para verificarlos en tu sistema. */
function secretCard(settings) {
  const input = h('input', { type: 'password', readonly: true, value: settings.webhook_secret, autocomplete: 'off' });
  return h('div', { class: 'card' },
    h('h2', {}, 'Secreto para verificar los webhooks'),
    h('p', { class: 'muted small' }, 'Cada aviso trae la cabecera x-riverrun-signature calculada con este secreto: compruébala en tu sistema para saber que el aviso es nuestro (ejemplo en la documentación).'),
    field('Secreto de webhooks', h('div', { class: 'row' }, input,
      h('button', { class: 'small', onclick: (e) => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Ocultar' : 'Mostrar'; } }, 'Mostrar'),
      copyButton(settings.webhook_secret, 'Copiar', 'el secreto de webhooks'),
      h('button', { class: 'small danger', onclick: async () => {
        if (!(await confirmAction('¿Cambiar el secreto? Los sistemas que verifican la firma rechazarán los avisos hasta que les pongas el nuevo. El enlace del calendario no cambia.', 'Cambiar secreto'))) return;
        if (await run(() => api('POST', '/api/settings/rotate-webhook-secret', acctBody()), 'Secreto cambiado: ponlo en tu sistema')) render();
      } }, 'Cambiar secreto'))));
}

/* ------------------------------ Webhooks ------------------------------ */

/** Casillas de eventos, con su nombre técnico (el que llega en «type»). */
function eventPicker(events, picked) {
  return h('div', { class: 'small event-picker' }, events.map((e) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: picked.has(e.type), onchange: (ev) => (ev.target.checked ? picked.add(e.type) : picked.delete(e.type)) }),
    e.label, ' ', h('code', { class: 'muted' }, e.type))));
}

/** Lo que se envió en una entrega, para ver los campos o depurar. */
async function showDelivery(ep, d) {
  const r = await run(() => api('GET', `/api/webhook-endpoints/${ep.id}/deliveries/${d.id}`));
  if (!r) return;
  await dialog(`Entrega: ${d.event}`, h('div', {},
    h('p', { class: 'small' }, `${fmtDate(d.created_at)} · intento ${d.attempt} · ${d.ok ? 'llegó bien' : `falló (${d.status_code || d.error})`}`),
    r.body ? codeBlock(JSON.stringify(r.body, null, 2), 'el cuerpo del evento') : h('p', { class: 'muted' }, 'El cuerpo de este evento ya no está guardado (se guarda 30 días).')), 'Cerrar');
}

async function deliveriesDialog(ep) {
  const rows = await run(() => api('GET', `/api/webhook-endpoints/${ep.id}/deliveries`));
  if (!rows) return;
  const list = rows.length
    ? h('ul', { class: 'delivery-list' }, rows.map((d) => h('li', { class: 'row between' },
        h('span', {}, `${fmtDate(d.created_at)} · ${d.event} · `, d.ok ? h('span', { class: 'badge green' }, 'Llegó') : h('span', { class: 'badge red' }, `Falló (${d.status_code || d.error})`), d.attempt > 1 ? ` · intento ${d.attempt}` : ''),
        h('span', { class: 'row' },
          h('button', { class: 'small', onclick: () => showDelivery(ep, d) }, 'Ver'),
          d.redeliverable ? h('button', { class: 'small', onclick: async () => { await run(() => api('POST', `/api/webhook-endpoints/${ep.id}/deliveries/${d.id}/redeliver`), 'Reenviado: llegará en unos segundos'); } }, 'Reenviar') : null))))
    : h('p', { class: 'muted' }, 'Todavía no hay entregas.');
  await dialog('Entregas del webhook', h('div', {}, h('p', { class: 'muted small' }, 'Las últimas 50. Si una falla, se reintenta sola 6 veces en unas 8 horas; con «Reenviar» la mandas otra vez cuando quieras.'), list), 'Cerrar');
}

async function testDialog(ep, events) {
  const mine = ep.events.includes('*') ? events.filter((e) => e.in_all) : events.filter((e) => ep.events.includes(e.type));
  const draft = { event: mine[0]?.type ?? 'ping' };
  const select = h('select', { onchange: (e) => (draft.event = e.target.value) },
    h('option', { value: 'ping' }, 'Prueba de conexión (ping)'),
    events.map((e) => h('option', { value: e.type, selected: e.type === draft.event }, `${e.label} (${e.type})`)));
  if (!(await dialog('Enviar prueba', h('div', {}, field('Evento', select, 'Llega un ejemplo con la forma real del evento y los datos más recientes de tu cuenta, marcado "test": true. Sirve para mapear los campos en Zapier o Make.')), 'Enviar'))) return;
  const r = await run(() => api('POST', `/api/webhook-endpoints/${ep.id}/test`, { event: draft.event }));
  if (r) toast(r.ok ? 'La prueba llegó bien' : `La prueba falló: ${r.error || r.status_code}`, !r.ok);
  render();
}

async function editDialog(ep, events) {
  const draft = { url: ep.url, description: ep.description };
  const picked = new Set(ep.events.includes('*') ? events.filter((e) => e.in_all).map((e) => e.type) : ep.events);
  const ok = await dialog('Editar webhook', h('div', {},
    field('Dirección (URL)', text(draft, 'url', { type: 'url', required: true })),
    field('Descripción', text(draft, 'description')),
    field('Eventos', eventPicker(events, picked))), 'Guardar', () => picked.size > 0 || (toast('Elige al menos un evento', true), false));
  if (!ok) return;
  if (await run(() => api('PUT', `/api/webhook-endpoints/${ep.id}`, { url: draft.url, description: draft.description, events: [...picked], active: ep.active }), 'Guardado')) render();
}

function endpointCard(ep, events) {
  const label = (e) => (e === '*' ? 'Todos los eventos de siempre' : events.find((x) => x.type === e)?.label || e);
  const status = ep.disabled_reason ? h('span', { class: 'badge red' }, 'Pausado por fallos') : ep.active ? h('span', { class: 'badge green' }, 'Activo') : h('span', { class: 'badge' }, 'Apagado');
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('strong', {}, ep.description || ep.url), status),
    h('div', { class: 'muted small' }, ep.url),
    h('div', { class: 'muted small' }, `Eventos: ${ep.events.map(label).join(', ')}`),
    ep.disabled_reason ? h('div', { class: 'small' }, ep.disabled_reason) : ep.last_delivery && !ep.last_delivery.ok ? h('div', { class: 'small' }, `Última entrega fallida: ${ep.last_delivery.error || ep.last_delivery.status_code}`) : null,
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => testDialog(ep, events) }, 'Enviar prueba'),
      h('button', { class: 'small', onclick: () => deliveriesDialog(ep) }, 'Ver entregas'),
      h('button', { class: 'small', onclick: () => editDialog(ep, events) }, 'Editar'),
      h('button', { class: 'small', onclick: async () => { if (!(await run(() => api('PUT', `/api/webhook-endpoints/${ep.id}`, { url: ep.url, description: ep.description, events: ep.events, active: !ep.active }), 'Guardado'))) return; render(); } }, ep.active ? 'Apagar' : 'Encender'),
      h('button', { class: 'small danger', onclick: async () => { if (await confirmAction('¿Borrar este webhook?')) { if (!(await run(() => api('DELETE', `/api/webhook-endpoints/${ep.id}`), 'Borrado'))) return; render(); } } }, 'Borrar')));
}

export async function viewIntegrations(root, params) {
  const [endpoints, events, keys, channels, fields, settings] = await Promise.all([
    api('GET', withAcct('/api/webhook-endpoints')),
    api('GET', '/api/webhook-events'),
    api('GET', withAcct('/api/api-keys')),
    api('GET', withAcct('/api/channels')),
    api('GET', withAcct('/api/contact-fields')),
    api('GET', withAcct('/api/settings')),
  ]);
  root.append(
    h('h1', {}, 'Integraciones'),
    h('p', { class: 'muted' }, 'Conecta tu asistente con tu CRM, tu tienda, Zapier, Make o n8n, y con tu calendario (Google u Outlook).'),
    connectCard({ channels, fields, keys }),
    await calendarCard(params, 'google'), await calendarCard(params, 'outlook'));

  const draft = { url: '', description: '' };
  const picked = new Set(events.filter((e) => e.default).map((e) => e.type));
  root.append(
    h('h2', {}, 'Webhooks (avisos a otros sistemas)'),
    h('p', { class: 'muted small' }, 'Cuando pasa algo (un cliente nuevo, una cita, un pago), te avisamos con un POST a tu dirección. Cada aviso trae el contacto con la misma forma que la API.'),
    ...(endpoints.length ? endpoints.map((ep) => endpointCard(ep, events)) : [h('p', { class: 'muted' }, 'Aún no tienes webhooks.')]),
    h('div', { class: 'card' },
      h('h2', {}, 'Nuevo webhook'),
      field('Dirección (URL)', text(draft, 'url', { type: 'url', placeholder: 'https://hooks.zapier.com/…' })),
      field('Descripción', text(draft, 'description', { placeholder: 'Pasar contactos nuevos a mi CRM' })),
      field('Eventos', eventPicker(events, picked)),
      h('button', { class: 'primary', onclick: async () => { if (!picked.size) return toast('Elige al menos un evento', true); if (!(await run(() => api('POST', '/api/webhook-endpoints', acctBody({ url: draft.url, description: draft.description, events: [...picked] })), 'Webhook creado'))) return; render(); } }, 'Crear webhook')),
    secretCard(settings));

  const kd = { name: '', scope: 'read' };
  root.append(
    h('h2', {}, 'Llaves de la API'),
    keys.length
      ? h('div', { class: 'card' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Nombre'), h('th', {}, 'Llave'), h('th', {}, 'Permiso'), h('th', {}, 'Último uso'), h('th', {}, h('span', { class: 'sr-only' }, 'Acciones')))),
        h('tbody', {}, keys.map((k) => h('tr', {}, h('td', {}, k.name), h('td', {}, `${k.prefix}…`), h('td', {}, k.scope === 'write' ? 'Lectura y escritura' : 'Solo lectura'), h('td', {}, k.revoked_at ? 'Revocada' : fmtDate(k.last_used_at) || 'Sin uso'),
          h('td', {}, k.revoked_at ? null : h('button', { class: 'small danger', onclick: async () => { if (await confirmAction('¿Revocar esta llave? Lo que la use dejará de funcionar.')) { if (!(await run(() => api('DELETE', `/api/api-keys/${k.id}`), 'Revocada'))) return; render(); } } }, 'Revocar')))))))
      : h('p', { class: 'muted' }, 'Aún no tienes llaves.'),
    h('div', { class: 'card' },
      field('Nombre de la llave', text(kd, 'name', { placeholder: 'Mi CRM' })),
      field('Permiso', h('select', { onchange: (e) => (kd.scope = e.target.value) }, h('option', { value: 'read' }, 'Solo lectura'), h('option', { value: 'write' }, 'Lectura y escritura'))),
      h('button', { class: 'primary', onclick: async () => {
        const r = await run(() => api('POST', '/api/api-keys', acctBody({ name: kd.name, scope: kd.scope })));
        if (r) { await ask('Copia tu llave ahora. Por seguridad no se vuelve a mostrar:', r.key, { title: 'Tu llave nueva', accept: 'Ya la copié' }); render(); }
      } }, 'Crear llave')));
}
