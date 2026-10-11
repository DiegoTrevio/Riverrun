import { api, dialog, field, fmtDate, h, run, text, toast, confirmAction, ask } from './core.js';
import { render } from './main.js';
import { withAcct } from './session.js';

/* ------------------------------ Integraciones ------------------------------ */

const acctBody = (b = {}) => ({ ...b, ...Object.fromEntries(new URLSearchParams(withAcct('?').slice(1))) });

async function googleCard(params) {
  const g = await api('GET', withAcct('/api/integrations/google'));
  const flash = params.get('google');
  const note = { ok: ['Google Calendar quedó conectado.', false], cancelado: ['Cancelaste la conexión con Google.', false], error: [params.get('msg') || 'No se pudo conectar con Google.', true] }[flash];
  if (note) toast(note[0], note[1]);
  const body = !g.available
    ? [h('p', { class: 'muted' }, 'Esta instalación todavía no tiene Google configurado. Quien administra el servidor debe definir GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (ver docs/integraciones.md).')]
    : g.connected
      ? [
          h('p', {}, `Conectado${g.email ? ` como ${g.email}` : ''}. Cada cita que se agende, cambie o cancele aparece en tu calendario.`),
          g.last_error ? h('p', { class: 'badge red' }, `Último error: ${g.last_error}`) : null,
          h('p', { class: 'muted small' }, g.block_busy ? 'Los horarios en que estás ocupado en Google no se ofrecen a los clientes.' : 'Los horarios ocupados en Google no se bloquean.'),
          h('div', { class: 'row' },
            h('button', { onclick: async () => { const v = !g.block_busy; if (!(await run(() => api('PUT', '/api/integrations/google', acctBody({ block_busy: v })), 'Guardado'))) return; render(); } }, g.block_busy ? 'Dejar de bloquear horarios ocupados' : 'Bloquear horarios ocupados'),
            h('button', { class: 'danger', onclick: async () => { if (await confirmAction('¿Desconectar Google Calendar? Los eventos ya creados se quedan en tu calendario.')) { if (!(await run(() => api('DELETE', withAcct('/api/integrations/google')), 'Desconectado'))) return; render(); } } }, 'Desconectar')),
        ]
      : [
          h('p', { class: 'muted' }, 'Copia tus citas a Google Calendar y evita que el asistente ofrezca horas en las que ya estás ocupado.'),
          h('button', { class: 'primary', onclick: async () => { const r = await run(() => api('POST', '/api/integrations/google/connect', acctBody())); if (r) location.href = r.url; } }, 'Conectar Google Calendar'),
        ];
  return h('div', { class: 'card' }, h('h2', {}, '📅 Google Calendar'), ...body);
}

function endpointCard(ep, events) {
  const label = (e) => (e === '*' ? 'Todos los eventos' : events.find((x) => x.type === e)?.label || e);
  const status = ep.disabled_reason ? h('span', { class: 'badge red' }, 'Pausado por fallos') : ep.active ? h('span', { class: 'badge green' }, 'Activo') : h('span', { class: 'badge' }, 'Apagado');
  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('strong', {}, ep.description || ep.url), status),
    h('div', { class: 'muted small' }, ep.url),
    h('div', { class: 'muted small' }, `Eventos: ${ep.events.map(label).join(', ')}`),
    ep.disabled_reason ? h('div', { class: 'small' }, ep.disabled_reason) : ep.last_delivery && !ep.last_delivery.ok ? h('div', { class: 'small' }, `Última entrega fallida: ${ep.last_delivery.error || ep.last_delivery.status_code}`) : null,
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: async () => { const r = await run(() => api('POST', `/api/webhook-endpoints/${ep.id}/test`)); if (r) toast(r.ok ? 'La prueba llegó bien' : `La prueba falló: ${r.error || r.status_code}`, !r.ok); render(); } }, 'Enviar prueba'),
      h('button', { class: 'small', onclick: async () => {
        const rows = await run(() => api('GET', `/api/webhook-endpoints/${ep.id}/deliveries`));
        if (rows) await dialog('Entregas del webhook', h('div', { class: 'pre' }, rows.length ? rows.map((d) => `${fmtDate(d.created_at)} · ${d.event} · ${d.ok ? 'OK' : `Falló (${d.status_code || d.error})`}`).join('\n') : 'Todavía no hay entregas.'), 'Cerrar');
      } }, 'Ver entregas'),
      h('button', { class: 'small', onclick: async () => { if (!(await run(() => api('PUT', `/api/webhook-endpoints/${ep.id}`, { url: ep.url, description: ep.description, events: ep.events, active: !ep.active }), 'Guardado'))) return; render(); } }, ep.active ? 'Apagar' : 'Encender'),
      h('button', { class: 'small danger', onclick: async () => { if (await confirmAction('¿Borrar este webhook?')) { if (!(await run(() => api('DELETE', `/api/webhook-endpoints/${ep.id}`), 'Borrado'))) return; render(); } } }, 'Borrar')));
}

export async function viewIntegrations(root, params) {
  const [endpoints, events, keys] = await Promise.all([
    api('GET', withAcct('/api/webhook-endpoints')),
    api('GET', '/api/webhook-events'),
    api('GET', withAcct('/api/api-keys')),
  ]);
  root.append(h('h1', {}, 'Integraciones'), h('p', { class: 'muted' }, 'Conecta tu asistente con tu calendario, tu CRM, Zapier, Make o n8n. Guía completa en docs/integraciones.md.'), await googleCard(params));

  const draft = { url: '', description: '', events: ['*'] };
  const picked = new Set(['*']);
  const eventBoxes = h('div', { class: 'small' }, events.map((e) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: e.default, onchange: (ev) => { picked.has('*') && picked.delete('*'); ev.target.checked ? picked.add(e.type) : picked.delete(e.type); } }), e.label)));
  events.filter((e) => e.default).forEach((e) => picked.add(e.type));
  picked.delete('*');
  root.append(
    h('h2', {}, 'Webhooks (avisos a otros sistemas)'),
    ...(endpoints.length ? endpoints.map((ep) => endpointCard(ep, events)) : [h('p', { class: 'muted' }, 'Aún no tienes webhooks.')]),
    h('div', { class: 'card' },
      h('h2', {}, 'Nuevo webhook'),
      field('Dirección (URL)', text(draft, 'url', { placeholder: 'https://hooks.zapier.com/…' })),
      field('Descripción', text(draft, 'description', { placeholder: 'Pasar contactos nuevos a mi CRM' })),
      field('Eventos', eventBoxes),
      h('button', { class: 'primary', onclick: async () => { if (!(await run(() => api('POST', '/api/webhook-endpoints', acctBody({ url: draft.url, description: draft.description, events: [...picked] })), 'Webhook creado'))) return; render(); } }, 'Crear webhook')));

  const kd = { name: '', scope: 'read' };
  root.append(
    h('h2', {}, 'Llaves de la API'),
    keys.length
      ? h('div', { class: 'card' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Nombre'), h('th', {}, 'Llave'), h('th', {}, 'Permiso'), h('th', {}, 'Último uso'), h('th', {}))),
        h('tbody', {}, keys.map((k) => h('tr', {}, h('td', {}, k.name), h('td', {}, `${k.prefix}…`), h('td', {}, k.scope === 'write' ? 'Lectura y escritura' : 'Solo lectura'), h('td', {}, k.revoked_at ? 'Revocada' : fmtDate(k.last_used_at) || 'Sin uso'),
          h('td', {}, k.revoked_at ? null : h('button', { class: 'small danger', onclick: async () => { if (await confirmAction('¿Revocar esta llave? Lo que la use dejará de funcionar.')) { if (!(await run(() => api('DELETE', `/api/api-keys/${k.id}`), 'Revocada'))) return; render(); } } }, 'Revocar')))))))
      : h('p', { class: 'muted' }, 'Aún no tienes llaves.'),
    h('div', { class: 'card' },
      field('Nombre de la llave', text(kd, 'name', { placeholder: 'Mi CRM' })),
      field('Permiso', h('select', { onchange: (e) => (kd.scope = e.target.value) }, h('option', { value: 'read' }, 'Solo lectura'), h('option', { value: 'write' }, 'Lectura y escritura'))),
      h('button', { class: 'primary', onclick: async () => {
        const r = await run(() => api('POST', '/api/api-keys', acctBody({ name: kd.name, scope: kd.scope })));
        if (r) { await ask('Copia tu llave ahora. Por seguridad no se vuelve a mostrar:', r.key); render(); }
      } }, 'Crear llave')));
}
