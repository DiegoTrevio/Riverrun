import { dataLabel, flowCard } from './bot.js';
import { channelIcon } from './channels.js';
import { api, area, check, clone, dialog, field, fill, fmtDate, h, lines, poll, run, select, state, text, toast, confirmAction, ask } from './core.js';
import { acct, isAdmin, isSuper, withAcct } from './session.js';

/* ------------------------------ Conversaciones ------------------------------ */

const STATUS_BADGE = { bot: ['green', 'Bot'], human: ['orange', 'Humano'], closed: ['', 'Cerrada'] };

/** Última vez que una persona tomó la conversación del contacto: desde dónde y quién (queda en el contacto). */
function handoffLine(ct, by) {
  if (!ct.handoff_at) return null;
  const who = by ? by.name || by.email : '';
  const phrase = {
    telefono: 'Atendida desde el teléfono del negocio',
    panel: `Atendida desde el panel${who ? ` por ${who}` : ''}`,
    regla: who ? `Asignada por una regla a ${who}` : 'Pasada a una persona por una regla',
    bot: 'Pasada a una persona por el asistente',
  }[ct.handoff_via] || 'Atendida por una persona';
  return h('p', { class: 'muted small' }, `${phrase} · ${fmtDate(ct.handoff_at)}`);
}

/** Pendientes y notas del cliente: lo que falta por hacer con esa persona, o dónde se quedó la conversación. */
function tasksCard(data, c, ct, reload, draft) {
  let adding = false;
  const tasks = data.tasks || [];
  const open = tasks.filter((t) => t.kind === 'pendiente' && t.status === 'abierta').length;
  const row = (t) => {
    const meta = [
      t.kind === 'pendiente' && t.due_on ? `vence ${t.due_on}` : '',
      t.created_by_name ? `por ${t.created_by_name}` : t.created_via === 'regla' ? 'por una regla' : '',
      t.conversation_id === c.id ? 'en esta conversación' : '',
      t.kind === 'pendiente' && t.status === 'hecha' && t.done_at ? `hecho el ${fmtDate(t.done_at)}` : '',
    ].filter(Boolean).join(' · ');
    return h('div', { class: `task-row${t.status === 'hecha' ? ' done' : ''}` },
      t.kind === 'pendiente'
        ? h('input', { type: 'checkbox', checked: t.status === 'hecha', title: 'Marcar como hecho', onchange: async (e) => { if (await run(() => api('PATCH', `/api/tasks/${t.id}`, { status: e.target.checked ? 'hecha' : 'abierta' }))) reload(); } })
        : h('span', { class: 'badge' }, 'nota'),
      h('div', { style: 'flex:1' }, h('div', { class: 'task-text' }, t.body), meta ? h('div', { class: 'small muted' }, meta) : null),
      h('button', { class: 'small', title: 'Borrar', onclick: async () => { if (await run(() => api('DELETE', `/api/tasks/${t.id}`), 'Borrado')) reload(); } }, '✕'));
  };
  const add = async () => {
    if (adding) return;
    if (!draft.body.trim()) return toast('Escribe el pendiente o la nota', true);
    const body = { kind: draft.kind, body: draft.body.trim(), due_on: draft.kind === 'pendiente' && draft.due_on ? draft.due_on : null, conversation_id: c.id };
    adding = true;
    try { if (await run(() => api('POST', `/api/contacts/${ct.id}/tasks`, body), 'Guardado')) { draft.body = ''; draft.due_on = ''; await reload(); } } finally { adding = false; }
  };
  return h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Pendientes y notas', open ? h('span', { class: 'badge orange', style: 'margin-left:6px' }, `${open} abierto${open === 1 ? '' : 's'}`) : null),
    h('p', { class: 'small muted', style: 'margin-top:0' }, 'Lo que falta por hacer con esta persona, o dónde se quedó la conversación.'),
    tasks.length ? h('div', { class: 'tasks' }, tasks.map(row)) : h('p', { class: 'small muted' }, 'Todavía no hay pendientes ni notas.'),
    h('div', { class: 'task-form' },
      field('Tipo de anotación', select(draft, 'kind', [['pendiente', 'Pendiente'], ['nota', 'Nota']])),
      field('Pendiente o nota', area(draft, 'body', { placeholder: 'Ej. Confirmar la cotización el jueves' })),
      h('div', { class: 'row' },
        h('input', { type: 'date', 'aria-label': 'Fecha límite (opcional, solo pendientes)', value: draft.due_on, oninput: (e) => (draft.due_on = e.target.value) }),
        h('button', { class: 'primary small', onclick: add }, 'Agregar'))));
}

/** Foto o documento del cliente: la imagen se ve en el chat y cualquier archivo se descarga tal como llegó. */
const customerMedia = (m) => {
  const url = `/api/messages/${m.id}/media`;
  const name = m.media_name || (m.media_kind === 'image' ? 'foto' : 'documento');
  const size = m.media_size ? (m.media_size >= 1048576 ? `${(m.media_size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(m.media_size / 1024))} KB`) : '';
  return h('div', { class: 'media' },
    m.media_kind === 'image' ? h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: name })) : null,
    h('a', { href: url, download: name }, `📎 ${name}${size ? ` · ${size}` : ''}`),
    m.media_complete === false ? h('div', { class: 'small muted' }, '⚠️ El archivo llegó incompleto: pídele al cliente que lo envíe de nuevo.') : null);
};

export async function viewConversations(root, params) {
  const [bots, channels] = await Promise.all([api('GET', `/api/chatbots${acct()}`), api('GET', `/api/channels${acct()}`)]);
  const f = {
    chatbot_id: params.get('chatbot_id') || '',
    channel_id: params.get('channel_id') || '',
    channel_type: params.get('channel_type') || '',
    status: params.get('status') || '',
    search: params.get('search') || '',
    assigned: params.get('assigned') || '',
  };
  const apply = () => { if (f.chatbot_id && f.channel_id && !channels.some((c) => c.id === f.channel_id && c.chatbot_id === f.chatbot_id)) f.channel_id = ''; if (f.channel_type && f.channel_id && !channels.some((c) => c.id === f.channel_id && c.type === f.channel_type)) f.channel_id = ''; location.hash = `#/conversations?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`; };
  const table = h('tbody');
  const showAccount = isSuper() && !state.accountId;
  let cursor = '';
  let rowsSoFar = [];
  let loading = false;
  const more = h('button', { hidden: true, onclick: () => load(true) }, 'Cargar más conversaciones');
  const load = async (append = false) => {
    if (loading) return;
    loading = true; more.disabled = true;
    try {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    if (isSuper() && state.accountId) qs.set('account_id', state.accountId);
    qs.set('page', 'true');
    if (append && cursor) qs.set('cursor', cursor);
    const page = await api('GET', `/api/conversations?${qs}`);
    cursor = page.next_cursor; more.hidden = !page.has_more;
    rowsSoFar = append ? [...rowsSoFar, ...page.items.filter((r) => !rowsSoFar.some((old) => old.id === r.id))] : page.items;
    const rows = rowsSoFar;
    fill(table,
      ...(rows.length ? rows.map((c) => {
        const [cls, label] = STATUS_BADGE[c.status] || ['', c.status];
        return h('tr', { class: 'click', onclick: () => (location.hash = `#/conversation/${c.id}`) },
          h('td', {}, h('a', { href: `#/conversation/${c.id}` }, h('strong', {}, c.name || c.push_name || (c.channel_type === 'webchat' ? 'Visitante del sitio' : 'Sin nombre'))), h('div', { class: 'muted small' }, c.phone ? `+${c.phone}` : '')),
          h('td', {}, channelIcon(c.channel_type), ' ', c.channel_name, h('div', { class: 'muted small' }, c.chatbot_name || 'sin chatbot')),
          showAccount ? h('td', { class: 'small' }, c.account_name) : null,
          h('td', {}, h('span', { class: `badge ${cls}` }, label), c.status === 'human' && c.handoff_reason ? h('div', { class: 'muted small' }, c.handoff_reason) : null),
          h('td', { class: 'small' }, c.assigned_user_id ? `👤 ${c.assigned_name || c.assigned_email}` : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'muted' }, (c.last_message || '').slice(0, 90)),
          h('td', { class: 'muted small' }, fmtDate(c.last_message_at)));
      }) : [h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No hay conversaciones.'))]),
    );
    } finally { loading = false; more.disabled = false; }
  };
  const types = state.meta.channel_types.map((t) => [t.type, t.label]);
  // Exportar a CSV (se abre en Excel o Google Sheets); respeta los filtros de arriba cuando aplican.
  const exportUrl = (kind) => {
    const qs = new URLSearchParams();
    if (isSuper() && state.accountId) qs.set('account_id', state.accountId);
    if (f.channel_id) qs.set('channel_id', f.channel_id);
    if (f.chatbot_id && kind === 'conversations') qs.set('chatbot_id', f.chatbot_id);
    if (f.status && kind === 'conversations') qs.set('status', f.status);
    return `/api/export/${kind}.csv?${qs}`;
  };
  const exportMenu = isAdmin()
    ? h('details', { class: 'menu' },
      h('summary', { class: 'btn' }, '⬇ Exportar'),
      h('div', { class: 'menu-items' },
        h('a', { href: exportUrl('contacts'), download: '' }, '👥 Contactos (CSV)'),
        h('a', { href: exportUrl('conversations'), download: '' }, '💬 Conversaciones (CSV)'),
        h('a', { href: exportUrl('messages'), download: '' }, '📝 Mensajes completos (CSV)')))
    : null;
  root.append(
    h('div', { class: 'row between' }, h('h1', {}, 'Conversaciones'), exportMenu),
    h('div', { class: 'card row' },
      h('div', { class: 'filter' }, field('Agente', select(f, 'chatbot_id', [['', 'Todos los chatbots'], ...bots.map((b) => [b.id, b.name])], apply))),
      h('div', { class: 'filter' }, field('Plataforma', select(f, 'channel_type', [['', 'Todas las plataformas'], ...types], apply))),
      h('div', { class: 'filter' }, field('Conexión', select(f, 'channel_id', [['', 'Todos los canales'], ...channels.map((c) => [c.id, c.name])], apply))),
      h('div', { class: 'filter' }, field('Estado', select(f, 'status', [['', 'Todos los estados'], ['bot', 'Atendidas por bot'], ['human', 'Con humano'], ['closed', 'Cerradas']], apply))),
      // El agente solo ve sus conversaciones: el filtro por persona no le sirve.
      isAdmin() ? h('div', { class: 'filter' }, field('Atiende', select(f, 'assigned', [['', 'Todas las personas'], ['me', 'Asignadas a mí'], ['none', 'Sin asignar']], apply))) : null,
      h('div', { class: 'search-field' }, h('input', { type: 'search', 'aria-label': 'Buscar nombre o teléfono', placeholder: 'Buscar nombre o teléfono…', value: f.search, onchange: (e) => { f.search = e.target.value; apply(); } }))),
    h('button', { class: 'small', onclick: () => { location.hash = '#/conversations'; } }, 'Limpiar filtros'),
    h('div', { class: 'card' }, h('table', { class: 'responsive-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Cliente'), h('th', {}, 'Canal'), showAccount ? h('th', {}, 'Cuenta') : null, h('th', {}, 'Estado'), h('th', {}, 'Asignada a'), h('th', {}, 'Último mensaje'), h('th', {}, 'Fecha'))), table)),
  );
  root.append(h('button', { class: 'small', onclick: () => load() }, 'Actualizar bandeja'), more);
  await load();
  poll(() => { if (!rowsSoFar.length || rowsSoFar.length <= 100) return load(); }, 10000, root);
}

export async function viewConversation(root, id) {
  const chat = h('div', { class: 'chat', id: 'conversation-messages', tabindex: '-1', 'aria-label': 'Mensajes de la conversación' });
  const side = h('div');
  const header = h('div');
  const input = h('textarea', { 'aria-label': 'Mensaje al cliente', placeholder: 'Escribe como persona del equipo… (Enter para enviar)', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  let messageSignature = '';
  let headerSignature = '';
  let firstMessageId = null;
  const messageMap = new Map();
  let sending = false;
  let loadingChat = false;
  let sideDirty = false;
  let sideVersion = null;
  const sideHint = h('p', { class: 'small', role: 'status', hidden: true }, 'Cambios sin guardar. La actualización automática no los modifica.');
  const markContactDirty = (event) => { if (event.target.closest('#customer-data')) { sideDirty = true; sideHint.hidden = false; } };
  side.addEventListener('input', markContactDirty);
  side.addEventListener('change', markContactDirty);
  const taskDraft = { kind: 'pendiente', body: '', due_on: '' };
  const tasksBox = h('div');
  const refreshTasks = () => fill(tasksBox, tasksCard(data, data.conversation, data.contact, async () => { await load(); refreshTasks(); }, taskDraft));
  const older = h('button', { class: 'small', hidden: true, onclick: async () => { if (!messageMap.size) return; const d = await run(() => api('GET', `/api/conversations/${id}?before=${Math.min(...messageMap.keys())}`)); if (d) { older.hidden = !d.has_more_messages; d.messages.forEach((m) => messageMap.set(Number(m.id), m)); await load(); } } }, 'Cargar mensajes anteriores');
  let data;

  const send = async () => {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true; sendButton.disabled = true;
    const ok = await run(() => api('POST', `/api/conversations/${id}/send`, { text }));
    sending = false; sendButton.disabled = false;
    if (ok) { if (input.value.trim() === text) input.value = ''; await load(true); }
  };

  // Galería del catálogo para enviar una foto a mano.
  const gallery = h('div', { class: 'gallery', hidden: true });
  const togglePhotos = async () => {
    if (!gallery.hidden) { gallery.hidden = true; return; }
    if (!data?.chatbot) return toast('Esta conversación no tiene asistente: no hay catálogo de fotos', true);
    const imgs = (await api('GET', `/api/chatbots/${data.chatbot.id}/images`)).filter((i) => i.active);
    fill(gallery, imgs.length
      ? imgs.map((img) => h('button', { class: 'thumb', title: `Enviar "${img.name}"`, onclick: async (event) => {
          if (sending) return; sending = true; const button = event.currentTarget; button.disabled = true;
          try { if (await run(() => api('POST', `/api/conversations/${id}/send-image`, { image_id: img.id }), 'Foto enviada')) { gallery.hidden = true; await load(true); } }
          finally { sending = false; button.disabled = false; }
        } }, h('img', { src: `/api/images/${img.id}/file?v=${encodeURIComponent(img.file_path)}`, alt: img.name, loading: 'lazy' }), h('span', { class: 'small' }, img.name)))
      : h('p', { class: 'muted small' }, 'No hay fotos activas. Súbelas en el asistente → Fotos.'));
    gallery.hidden = false;
  };

  let team = null;
  /** Quién atiende esta conversación y a quién pasársela (round robin o una persona concreta). */
  const assignRow = (d) => {
    const c = d.conversation;
    const me = state.me.user;
    const sel = h('select', { 'aria-label': 'Asignar conversación', style: 'width:auto;max-width:260px', onchange: async (e) => {
      const v = e.target.value;
      if (!v) return;
      const r = await run(() => api('PUT', `/api/conversations/${id}/assign`, { user_id: v === 'none' ? null : v }), v === 'none' ? 'Sin asignar' : 'Asignada');
      if (r) load(true);
    } },
      h('option', { value: '' }, 'Cambiar asignación…'),
      isAdmin() ? h('option', { value: 'next' }, '🔄 Siguiente por turnos') : null,
      isAdmin() ? (team || []).map((u) => h('option', { value: u.id }, `${u.name || u.email}${u.available === false ? ' (no disponible)' : ''}`)) : null,
      c.assigned_user_id ? h('option', { value: 'none' }, 'Quitar asignación') : null);
    return h('div', { class: 'row', style: 'margin:0 0 8px' },
      h('span', { class: 'small muted' }, 'Atiende:'),
      c.assigned_user_id ? h('span', { class: 'badge green' }, `👤 ${d.assignee?.name || d.assignee?.email || 'alguien'}${c.assigned_user_id === me.id ? ' (tú)' : ''}`) : h('span', { class: 'badge' }, 'sin asignar'),
      c.assigned_user_id !== me.id ? h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/conversations/${id}/assign`, { user_id: 'me' }), 'Es tuya')) load(true); } }, 'Quedármela') : null,
      isAdmin() || c.assigned_user_id === me.id ? sel : null);
  };

  const load = async (force = false) => {
    if (loadingChat) return;
    loadingChat = true;
    try {
    if (team === null && isAdmin()) team = await api('GET', `/api/users${acct()}`).then((u) => u.filter((x) => x.account_id && x.active)).catch(() => []);
    const recent = [...messageMap.values()].filter((m) => m.direction === 'out').slice(-100).map((m) => m.id);
    const newest = messageMap.size ? Math.max(...messageMap.keys()) : null;
    data = await api('GET', `/api/conversations/${id}${newest !== null && !force ? `?after=${newest}${recent.length ? '&watch=' + recent.join(',') : ''}` : ''}`);
    if (!data.messages_incremental) older.hidden = !data.has_more_messages;
    state.timeZone = data.timezone;
    data.messages.forEach((m) => messageMap.set(Number(m.id), m));
    data.messages = [...messageMap.values()].sort((a, b) => Number(a.id) - Number(b.id));
    const { conversation: c, contact: ct, messages } = data;
    const [cls, label] = STATUS_BADGE[c.status] || ['', c.status];
    const nextHeader = JSON.stringify([c.status, c.handoff_reason, c.assigned_user_id, ct.name, ct.push_name, ct.phone, ct.handoff_at, data.handoff_by_user, data.channel?.name, data.chatbot?.name, data.agent]);
    if (nextHeader !== headerSignature) {
    headerSignature = nextHeader;
    fill(header, 
      h('div', { class: 'row between' },
        h('h1', {}, ct.name || ct.push_name || 'Cliente', ' ', h('span', { class: `badge ${cls}` }, label)),
        h('div', { class: 'row' },
          c.status !== 'human' ? h('button', { class: 'primary', onclick: async () => { if (!(await run(() => api('POST', `/api/conversations/${id}/takeover`), 'Tomaste la conversación'))) return; load(true); } }, 'Tomar conversación') : null,
          c.status !== 'bot' ? h('button', { class: 'primary', onclick: async () => { if (!(await run(() => api('POST', `/api/conversations/${id}/release`), 'El bot vuelve a responder'))) return; load(true); } }, 'Devolver al bot') : null,
          c.status !== 'closed' ? h('button', { onclick: async () => { if (!(await run(() => api('POST', `/api/conversations/${id}/close`), 'Cerrada'))) return; load(true); } }, 'Cerrar') : null)),
      assignRow(data),
      h('p', { class: 'muted' }, channelIcon(data.channel?.type), ' ', data.channel?.name, ' · ', data.chatbot?.name || 'sin chatbot', ct.phone ? ` · +${ct.phone}` : '', c.status === 'human' && c.handoff_reason ? ` · Motivo: ${c.handoff_reason}` : ''),
      handoffLine(ct, data.handoff_by_user),
      c.status === 'bot' && data.agent && !data.agent.on
        ? h('div', { class: 'card legend row between' },
            h('span', {}, h('span', { class: 'badge orange' }, data.agent.state === 'waiting' ? 'Asistente esperando su palabra de activación' : 'Asistente en pausa'), ' ',
              data.agent.state === 'paused' ? `${data.agent.reason}${data.agent.until ? ` · se reactiva ${fmtDate(data.agent.until)}` : ''}` : 'Aún no responde en esta conversación.'),
            h('button', { class: 'small', onclick: async () => { if (!(await run(() => api('POST', `/api/conversations/${id}/release`), 'El asistente vuelve a responder'))) return; load(true); } }, 'Reactivar asistente'))
        : null,
    );
    }
    const signature = JSON.stringify(messages.map((m) => [m.id, m.status, m.meta, m.content]));
    if (signature !== messageSignature) {
      const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 70;
      const previousTop = chat.scrollTop; const previousHeight = chat.scrollHeight;
      const firstRender = !messageSignature;
      const prepended = firstMessageId !== null && Number(messages[0]?.id) < firstMessageId;
      firstMessageId = Number(messages[0]?.id);
      messageSignature = signature;
      fill(chat, ...messages.map((m) => {
        const cls = ['bubble', m.direction === 'in' ? 'in' : 'out', m.sender === 'human' ? 'human' : '', m.status === 'failed' ? 'failed' : ''].join(' ');
        const who = m.sender === 'human' ? '👤 equipo' : m.sender === 'bot' ? '🤖 bot' : '';
        return h('div', { class: cls },
          m.image_id ? h('img', { src: `/api/images/${m.image_id}/file`, alt: m.image_name || '' }) : null,
          m.image_id ? h('div', { class: 'small muted' }, `🖼 ${m.image_code || ''}`) : null,
          m.meta?.attachment_id ? h('a', { href: `/api/attachments/${m.meta.attachment_id}/file`, target: '_blank', rel: 'noopener' }, `📎 ${m.meta.file_name || 'Archivo'}`) : null,
          m.media_kind ? customerMedia(m) : null,
          m.meta?.media_error ? h('div', { class: 'small muted' }, `⚠️ ${m.meta.media_error}`) : null,
          m.content || null,
          h('div', { class: 'meta' }, [who, fmtDate(m.created_at), m.status === 'failed' ? '⚠️ no enviado' : '', m.meta?.fallback ? 'respaldo' : ''].filter(Boolean).join(' · ')));
      }));
      chat.scrollTop = prepended ? previousTop + Math.max(0, chat.scrollHeight - previousHeight) : atBottom || firstRender ? chat.scrollHeight : previousTop;
    }
    if (!sideDirty && (force || !side.contains(document.activeElement))) drawSide();
    } finally { loadingChat = false; }
  };

  const autoBox = h('div', { id: 'conversation-appointments', tabindex: '-1' });
  /** Secuencias, citas y envíos programados de esta conversación. */
  const drawAuto = async () => {
    const [auto, seqs, services] = await Promise.all([
      api('GET', `/api/conversations/${id}/automation`),
      api('GET', withAcct('/api/sequences')).catch(() => []),
      api('GET', withAcct('/api/services')).catch(() => []),
    ]);
    const enr = { sequence_id: seqs.find((q) => q.active)?.id || '' };
    const book = { service_id: services.find((q) => q.active)?.id || '', slot: '', notes: '' };
    const slotBox = h('div');
    const loadSlots = async () => {
      if (!book.service_id) return;
      const slots = await api('GET', `/api/services/${book.service_id}/slots`);
      book.slot = slots[0]?.key || '';
      fill(slotBox, slots.length ? select(book, 'slot', slots.map((x) => [x.key, x.label])) : h('p', { class: 'small muted' }, 'Sin horarios disponibles'));
    };
    const active = auto.enrollments.filter((e) => e.status === 'active');
    const upcoming = auto.appointments.filter((a) => a.status === 'confirmed' && new Date(a.starts_at) > new Date());
    const JOB_LABEL = { sequence_step: 'Mensaje de secuencia', no_reply: 'Seguimiento si no responde', automation_send: 'Mensaje programado', appointment_reminder: 'Recordatorio de cita', campaign_send: 'Campaña', flow_image: 'Foto pendiente del recorrido' };
    fill(autoBox,
      h('div', { class: 'card' },
        h('h2', { style: 'margin-top:0' }, 'Citas'),
        upcoming.length ? upcoming.map((a) => h('div', { class: 'small' }, a.kind === 'call' ? '📞 ' : '📅 ', h('strong', {}, a.service_name), ` · ${fmtDate(a.starts_at)}`)) : h('p', { class: 'small muted', style: 'margin:0' }, 'Sin citas próximas'),
        services.length ? h('details', { style: 'margin-top:8px' }, h('summary', {}, 'Agendar cita o llamada'),
          field('Servicio', select(book, 'service_id', services.filter((q) => q.active).map((q) => [q.id, q.name]), loadSlots)),
          slotBox,
          field('Notas', text(book, 'notes')),
          h('button', { class: 'small primary', onclick: async () => { if (await run(() => api('POST', '/api/appointments', { ...book, conversation_id: id }), 'Agendada: se envió la confirmación al cliente')) { drawAuto(); load(true); } } }, 'Agendar y avisar al cliente')) : null),
      h('div', { class: 'card' },
        h('h2', { style: 'margin-top:0' }, 'Secuencias'),
        active.length ? active.map((e) => h('div', { class: 'row between small' }, h('span', {}, `▶ ${e.sequence_name} (paso ${e.current_step + 1})`),
          h('button', { class: 'small danger', onclick: async () => { if (!(await run(() => api('DELETE', `/api/conversations/${id}/sequences/${e.sequence_id}`), 'Detenida'))) return; drawAuto(); } }, 'Detener'))) : h('p', { class: 'small muted', style: 'margin:0' }, 'Ninguna en curso'),
        seqs.length ? h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { style: 'flex:1' }, select(enr, 'sequence_id', seqs.filter((q) => q.active).map((q) => [q.id, q.name]))),
          h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/conversations/${id}/sequences`, enr), 'Inscrito en la secuencia')) drawAuto(); } }, 'Iniciar')) : null,
        auto.jobs.length ? h('details', { style: 'margin-top:8px' }, h('summary', {}, `Envíos programados (${auto.jobs.length})`),
          auto.jobs.map((j) => h('div', { class: 'small muted' }, `${fmtDate(j.run_at)} · ${JOB_LABEL[j.type] || j.type}`))) : null),
    );
    if (services.length) loadSlots();
  };

  const drawSide = () => {
    const { conversation: c, contact: ct } = data;
    sideVersion = c.data_version;
    const m = { name: ct.name, data: { ...ct.data }, notes: [...(ct.notes || [])], tags: [...(ct.tags || [])], opted_out: !!ct.opted_out, consent: !!ct.consent_at };
    const fieldsDef = data.chatbot?.data_fields || [];
    let savingContact = false;
    const base = clone(m);
    const contactError = h('div', { class: 'small', role: 'status' });
    // Los campos de tipo "nombre" se editan en el campo Nombre del contacto.
    const nameKeys = [...new Set([...fieldsDef.filter((f) => f.type === 'name').map((f) => f.key), ...['nombre', 'name'].filter((k) => Object.hasOwn(ct.data || {}, k))])];
    const keys = [...new Set([...fieldsDef.map((f) => f.key), ...Object.keys(ct.data || {})])].filter((k) => !nameKeys.includes(k) && !(ct.name && ['nombre', 'name'].includes(k)));
    const payload = (model, version) => { const aliases = [...new Set([...nameKeys, ...['nombre', 'name'].filter((key) => Object.hasOwn(model.data, key))])]; return { ...model, base_data_version: version, data: Object.fromEntries(Object.entries({ ...model.data, ...Object.fromEntries(aliases.map((key) => [key, model.name])) }).filter(([, value]) => value)) }; };
    const saveContact = async (model = m, version = sideVersion) => {
      if (savingContact) return; savingContact = true;
      const snapshot = JSON.stringify(m);
      try {
        await api('PUT', `/api/contacts/${ct.id}`, payload(model, version));
        toast('Datos guardados');
        if (snapshot === JSON.stringify(m)) { sideDirty = false; sideHint.hidden = true; await load(true); }
        else { sideHint.textContent = 'Se guardó el envío anterior. Tienes cambios nuevos pendientes.'; }
      } catch (error) {
        fill(contactError, h('p', { class: 'error', role: 'alert' }, error.message), error.status === 409 ? h('button', { class: 'small', onclick: reviewContact }, 'Revisar cambios del cliente') : null);
      } finally { savingContact = false; }
    };
    const reviewContact = async () => {
      const current = await run(() => api('GET', `/api/conversations/${id}`));
      if (!current) return;
      const remote = { name: current.contact.name, data: { ...current.contact.data }, notes: [...current.contact.notes], tags: [...current.contact.tags], opted_out: !!current.contact.opted_out, consent: !!current.contact.consent_at };
      const merged = clone(remote); const decisions = [];
      const review = h('div', {}, h('p', {}, 'La conversación cambió. Conservamos los datos nuevos del cliente y te pedimos revisar los campos que también editaste.'));
      const entries = [...Object.keys(base).filter((key) => key !== 'data').map((key) => [key, base[key], m[key], remote[key]]), ...new Set([...Object.keys(base.data), ...Object.keys(m.data), ...Object.keys(remote.data)])].map((entry) => typeof entry === 'string' ? [`data.${entry}`, base.data[entry], m.data[entry], remote.data[entry]] : entry);
      for (const [key, previous, mine, server] of entries) {
        if (JSON.stringify(mine) === JSON.stringify(previous)) continue;
        const decision = { value: JSON.stringify(server) !== JSON.stringify(previous) && JSON.stringify(server) !== JSON.stringify(mine) ? 'server' : 'mine' };
        review.append(field(dataLabel(key.replace('data.', '')), select(decision, 'value', [['server', `Dato actual: ${JSON.stringify(server) ?? '(vacío)'}`], ['mine', `Mi cambio: ${JSON.stringify(mine) ?? '(vacío)'}`]])));
        decisions.push({ key, mine, decision });
      }
      if (!(await dialog('Revisar datos antes de guardar', review, 'Guardar cambios revisados'))) return;
      for (const { key, mine, decision } of decisions) if (decision.value === 'mine') { if (key.startsWith('data.')) { if (mine === undefined) delete merged.data[key.slice(5)]; else merged.data[key.slice(5)] = mine; } else merged[key] = mine; }
      await saveContact(merged, current.conversation.data_version);
    };
    fill(side, sideHint,
      (refreshTasks(), tasksBox),
      h('div', { class: 'card', id: 'customer-data', tabindex: '-1' },
        h('h2', { style: 'margin-top:0' }, 'Datos del cliente'),
        field('Nombre', text(m, 'name')),
        ...keys.map((k) => field(fieldsDef.find((f) => f.key === k)?.label || dataLabel(k), text(m.data, k))),
        field('Notas (memoria)', lines(m, 'notes')),
        field('Etiquetas', h('input', { type: 'text', value: m.tags.join(', '), placeholder: 'vip, interesado', oninput: (e) => (m.tags = e.target.value.split(',').map((x) => x.trim()).filter(Boolean)) }), 'Separadas por comas. Sirven para campañas y reglas.'),
        check(m, 'opted_out', 'Dado de baja (no recibe mensajes promocionales)'),
        check(m, 'consent', 'Aceptó recibir promociones'),
        ct.consent_at ? h('p', { class: 'small muted', style: 'margin:-4px 0 8px' }, `Consentimiento registrado el ${fmtDate(ct.consent_at)}${ct.consent_source ? ` (${{ keyword: 'lo escribió el cliente', panel: 'marcado por el equipo', legacy: 'cliente anterior a esta función', api: 'integración' }[ct.consent_source] || ct.consent_source})` : ''}.`) : null,
        h('button', { class: 'small', onclick: () => saveContact() }, 'Guardar datos'), contactError),
      isAdmin() ? h('details', { class: 'card' },
        h('summary', {}, '🔒 Privacidad de este cliente'),
        h('p', { class: 'small muted' }, 'Para atender una solicitud de acceso o supresión de datos personales.'),
        h('div', { class: 'row' },
          h('a', { class: 'btn small', href: `/api/contacts/${ct.id}/data`, download: '' }, 'Descargar todos sus datos'),
          h('button', { class: 'small danger', onclick: async () => {
            if (await ask('Se borrará este cliente y TODA su conversación, de forma definitiva. Escribe BORRAR para confirmar') !== 'BORRAR') return;
            if (await run(() => api('DELETE', `/api/contacts/${ct.id}`), 'Datos eliminados')) location.hash = '#/conversations';
          } }, 'Borrar todos sus datos'))) : null,
      flowCard(data.chatbot?.flow, c),
      autoBox,
      h('details', { class: 'card', id: 'conversation-summary', tabindex: '-1', open: !!c.report_summary },
        h('summary', {}, h('strong', {}, 'Resumen de la conversación'), c.report_summary ? null : h('span', { class: 'muted small' }, ' · sin generar')),
        h('div', { class: 'row' },
          h('button', { class: 'small primary', onclick: async (e) => {
            e.target.disabled = true;
            try { if (await run(() => api('POST', `/api/conversations/${id}/summary`), 'Resumen actualizado')) await load(true); }
            finally { e.target.disabled = false; }
          } }, c.report_summary ? 'Actualizar resumen' : 'Generar resumen')),
        h('p', { class: 'small pre' }, c.report_summary || 'Se genera al cerrar, completar el objetivo o transferir la conversación. Puedes pedirlo en cualquier momento.'),
        c.report_at ? h('p', { class: 'small muted' }, `Generado: ${fmtDate(c.report_at)}`, c.report_until_id < (data.messages.filter((m) => m.status === 'ok').at(-1)?.id || 0) || c.report_data_version !== c.data_version ? ' · Hay información nueva; actualiza el resumen.' : '') : null,
        c.report_analysis && c.report_summary ? h('div', { class: 'row small', style: 'gap:6px;flex-wrap:wrap' },
          c.report_analysis.intent ? h('span', { class: 'chip' }, `🎯 ${c.report_analysis.intent}`) : null,
          h('span', { class: 'chip' }, `Ánimo: ${c.report_analysis.sentiment || 'neutral'}`),
          h('span', { class: 'chip' }, `Interés: ${(c.report_analysis.interest || 'sin_dato').replace('_', ' ')}`),
          ...(c.report_analysis.agreements || []).map((x) => h('span', { class: 'chip' }, `🤝 ${x}`)),
          ...(c.report_analysis.next_steps || []).map((x) => h('span', { class: 'chip' }, `⏭ ${x}`))) : null,
        h('div', { class: 'row', style: 'gap:6px;margin:8px 0' },
          h('a', { class: 'btn small', href: `/api/conversations/${id}/report?format=txt&transcript=1`, download: '' }, '⬇ Descargar reporte'),
          h('button', { class: 'small', onclick: async () => {
            try {
              const res = await fetch(`/api/conversations/${id}/report?format=txt`);
              if (!res.ok) throw new Error('No se pudo obtener el reporte');
              await navigator.clipboard.writeText(await res.text());
              toast('Reporte copiado');
            } catch (e) { toast(e.message || 'No se pudo copiar', true); }
          } }, 'Copiar'),
          h('button', { class: 'small primary', onclick: () => sendReportDialog(id, data) }, '✉ Enviar reporte')),
        h('details', { class: 'small' }, h('summary', {}, 'Datos guardados en esta conversación'), h('div', { class: 'pre' }, Object.entries(c.data || {}).map(([key, value]) => `${key}: ${value}`).join('\n') || 'Aún no se han recopilado datos.')),
        c.summary ? h('details', { class: 'small' }, h('summary', {}, 'Memoria del asistente'), h('div', { class: 'pre muted' }, c.summary)) : null,
        h('button', { class: 'small danger', style: 'margin-top:10px', onclick: async () => { if (await confirmAction('¿Borrar memoria (resumen, datos y notas) de este cliente?')) { if (!(await run(() => api('POST', `/api/conversations/${id}/reset-memory`), 'Memoria borrada'))) return; load(true); } } }, 'Borrar memoria')),
      isAdmin() ? h('div', { class: 'card' }, h('a', { href: `#/logs?conversation_id=${id}` }, 'Ver registros de esta conversación →')) : null,
      h('button', { class: 'small', onclick: () => { chat.scrollIntoView({ block: 'start' }); chat.focus(); } }, 'Volver a los mensajes'),
    );
  };

  const sendButton = h('button', { class: 'primary', onclick: send }, 'Enviar');
  root.append(
    h('a', { href: '#/conversations' }, '← Conversaciones'),
    header,
    h('div', { class: 'row chat-shortcuts' }, [['customer-data', 'Datos del cliente'], ['conversation-summary', 'Resumen'], ['conversation-appointments', 'Citas y seguimientos']].map(([target, label]) => h('button', { class: 'small', onclick: () => { const el = document.getElementById(target); if (!el) return; if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); } }, label))),
    h('div', { class: 'split' },
      h('div', { class: 'card' }, older, chat, h('div', { class: 'composer' }, input, h('button', { onclick: togglePhotos, title: 'Enviar una foto del catálogo' }, '📷 Foto'), sendButton),
        gallery,
        h('p', { class: 'muted small' }, 'Al enviar un mensaje o una foto a mano, el bot se pausa en esta conversación hasta que la devuelvas.')),
      side),
  );
  await load(true);
  drawAuto().catch(() => undefined);
  poll(() => load(), 5000, root);
}


/** Ventana para enviar el reporte a personas del equipo (y, si es administrador, a correos o WhatsApp externos). */
async function sendReportDialog(id) {
  const people = await run(() => api('GET', `/api/conversations/${id}/report/recipients`));
  if (!people) return;
  const b = { user_ids: [], emails: [], phones: [], note: '', include_transcript: false, refresh: true };
  const result = h('div', { class: 'small' });
  const dlg = h('dialog', { class: 'card', style: 'max-width:520px;width:92vw' });
  const close = () => { dlg.close(); dlg.remove(); };
  const send = h('button', { class: 'primary', onclick: async () => {
    send.disabled = true;
    try {
      const r = await run(() => api('POST', `/api/conversations/${id}/report/send`, b));
      if (r) fill(result,
        r.warning ? h('p', { class: 'muted' }, `⚠️ ${r.warning}`) : null,
        r.deliveries.map((d) => h('div', {}, `${d.ok ? '✅' : '❌'} ${d.via}: ${d.to}${d.detail ? ` — ${d.detail}` : ''}`)));
    } finally { send.disabled = false; }
  } }, 'Enviar');
  dlg.append(
    h('h2', { style: 'margin-top:0' }, 'Enviar reporte de la conversación'),
    h('p', { class: 'small muted' }, 'Se actualiza el resumen y se envía por el panel, y por correo o WhatsApp a quien lo tenga activado.'),
    h('div', { class: 'row', style: 'flex-wrap:wrap' }, people.map((u) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', onchange: (e) => { b.user_ids = e.target.checked ? [...b.user_ids, u.id] : b.user_ids.filter((x) => x !== u.id); } }), u.name, u.whatsapp ? ' 📱' : ''))),
    isAdmin() ? field('Correos externos (uno por línea)', lines(b, 'emails', { placeholder: 'direccion@empresa.com' })) : null,
    isAdmin() ? field('WhatsApp externos (uno por línea)', lines(b, 'phones', { placeholder: '5215512345678' })) : null,
    field('Nota (opcional)', text(b, 'note')),
    check(b, 'include_transcript', 'Adjuntar los últimos mensajes'),
    result,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { onclick: close }, 'Cerrar'), send));
  document.body.append(dlg);
  dlg.showModal();
}
