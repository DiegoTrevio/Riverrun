import { dataLabel, flowCard } from './bot.js';
import { channelIcon } from './channels.js';
import { api, check, field, fill, fmtDate, h, lines, run, select, state, text, toast } from './core.js';
import { acct, isAdmin, isSuper, withAcct } from './session.js';

/* ------------------------------ Conversaciones ------------------------------ */

const STATUS_BADGE = { bot: ['green', 'Bot'], human: ['orange', 'Humano'], closed: ['', 'Cerrada'] };

export async function viewConversations(root, params) {
  const [bots, channels] = await Promise.all([api('GET', `/api/chatbots${acct()}`), api('GET', `/api/channels${acct()}`)]);
  const f = {
    chatbot_id: params.get('chatbot_id') || '',
    channel_id: params.get('channel_id') || '',
    channel_type: params.get('channel_type') || '',
    status: params.get('status') || '',
    search: params.get('search') || '',
  };
  const apply = () => { location.hash = `#/conversations?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`; };
  const table = h('tbody');
  const showAccount = isSuper() && !state.accountId;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    if (isSuper() && state.accountId) qs.set('account_id', state.accountId);
    const rows = await api('GET', `/api/conversations?${qs}`);
    fill(table,
      ...(rows.length ? rows.map((c) => {
        const [cls, label] = STATUS_BADGE[c.status] || ['', c.status];
        return h('tr', { class: 'click', onclick: () => (location.hash = `#/conversation/${c.id}`) },
          h('td', {}, h('strong', {}, c.name || c.push_name || (c.channel_type === 'webchat' ? 'Visitante del sitio' : 'Sin nombre')), h('div', { class: 'muted small' }, c.phone ? `+${c.phone}` : '')),
          h('td', {}, channelIcon(c.channel_type), ' ', c.channel_name, h('div', { class: 'muted small' }, c.chatbot_name || 'sin chatbot')),
          showAccount ? h('td', { class: 'small' }, c.account_name) : null,
          h('td', {}, h('span', { class: `badge ${cls}` }, label), c.status === 'human' && c.handoff_reason ? h('div', { class: 'muted small' }, c.handoff_reason) : null),
          h('td', { class: 'muted' }, (c.last_message || '').slice(0, 90)),
          h('td', { class: 'muted small' }, fmtDate(c.last_message_at)));
      }) : [h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No hay conversaciones.'))]),
    );
  };
  const types = state.meta.channel_types.map((t) => [t.type, t.label]);
  root.append(
    h('h1', {}, 'Conversaciones'),
    h('div', { class: 'card row' },
      h('div', { style: 'min-width:170px' }, select(f, 'chatbot_id', [['', 'Todos los chatbots'], ...bots.map((b) => [b.id, b.name])], apply)),
      h('div', { style: 'min-width:150px' }, select(f, 'channel_type', [['', 'Todas las plataformas'], ...types], apply)),
      h('div', { style: 'min-width:150px' }, select(f, 'channel_id', [['', 'Todos los canales'], ...channels.map((c) => [c.id, c.name])], apply)),
      h('div', { style: 'min-width:150px' }, select(f, 'status', [['', 'Todos los estados'], ['bot', 'Atendidas por bot'], ['human', 'Con humano'], ['closed', 'Cerradas']], apply)),
      h('div', { style: 'flex:1;min-width:160px' }, h('input', { type: 'search', placeholder: 'Buscar nombre o teléfono…', value: f.search, onchange: (e) => { f.search = e.target.value; apply(); } }))),
    h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Cliente'), h('th', {}, 'Canal'), showAccount ? h('th', {}, 'Cuenta') : null, h('th', {}, 'Estado'), h('th', {}, 'Último mensaje'), h('th', {}, 'Fecha'))), table)),
  );
  await load();
  state.timers.push(setInterval(() => load().catch(() => undefined), 10000));
}

export async function viewConversation(root, id) {
  const chat = h('div', { class: 'chat' });
  const side = h('div');
  const header = h('div');
  const input = h('textarea', { placeholder: 'Escribe como persona del equipo… (Enter para enviar)', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  let lastCount = -1;
  let data;

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    const ok = await run(() => api('POST', `/api/conversations/${id}/send`, { text }));
    if (ok) { input.value = ''; await load(true); }
  };

  // Galería del catálogo para enviar una foto a mano.
  const gallery = h('div', { class: 'gallery', hidden: true });
  const togglePhotos = async () => {
    if (!gallery.hidden) { gallery.hidden = true; return; }
    if (!data?.chatbot) return toast('Esta conversación no tiene asistente: no hay catálogo de fotos', true);
    const imgs = (await api('GET', `/api/chatbots/${data.chatbot.id}/images`)).filter((i) => i.active);
    fill(gallery, imgs.length
      ? imgs.map((img) => h('button', { class: 'thumb', title: `Enviar "${img.name}"`, onclick: async () => {
          if (await run(() => api('POST', `/api/conversations/${id}/send-image`, { image_id: img.id }), 'Foto enviada')) { gallery.hidden = true; await load(true); }
        } }, h('img', { src: `/api/images/${img.id}/file?v=${encodeURIComponent(img.file_path)}`, alt: img.name, loading: 'lazy' }), h('span', { class: 'small' }, img.name)))
      : h('p', { class: 'muted small' }, 'No hay fotos activas. Súbelas en el asistente → Fotos.'));
    gallery.hidden = false;
  };

  const load = async (force = false) => {
    data = await api('GET', `/api/conversations/${id}`);
    const { conversation: c, contact: ct, messages } = data;
    const [cls, label] = STATUS_BADGE[c.status] || ['', c.status];
    fill(header, 
      h('div', { class: 'row between' },
        h('h1', {}, ct.name || ct.push_name || 'Cliente', ' ', h('span', { class: `badge ${cls}` }, label)),
        h('div', { class: 'row' },
          c.status !== 'human' ? h('button', { class: 'primary', onclick: async () => { await run(() => api('POST', `/api/conversations/${id}/takeover`), 'Tomaste la conversación'); load(true); } }, 'Tomar conversación') : null,
          c.status !== 'bot' ? h('button', { class: 'primary', onclick: async () => { await run(() => api('POST', `/api/conversations/${id}/release`), 'El bot vuelve a responder'); load(true); } }, 'Devolver al bot') : null,
          c.status !== 'closed' ? h('button', { onclick: async () => { await run(() => api('POST', `/api/conversations/${id}/close`), 'Cerrada'); load(true); } }, 'Cerrar') : null)),
      h('p', { class: 'muted' }, channelIcon(data.channel?.type), ' ', data.channel?.name, ' · ', data.chatbot?.name || 'sin chatbot', ct.phone ? ` · +${ct.phone}` : '', c.status === 'human' && c.handoff_reason ? ` · Motivo: ${c.handoff_reason}` : ''),
      c.status === 'bot' && data.agent && !data.agent.on
        ? h('div', { class: 'card legend row between' },
            h('span', {}, h('span', { class: 'badge orange' }, data.agent.state === 'waiting' ? 'Asistente esperando su palabra de activación' : 'Asistente en pausa'), ' ',
              data.agent.state === 'paused' ? `${data.agent.reason}${data.agent.until ? ` · se reactiva ${fmtDate(data.agent.until)}` : ''}` : 'Aún no responde en esta conversación.'),
            h('button', { class: 'small', onclick: async () => { await run(() => api('POST', `/api/conversations/${id}/release`), 'El asistente vuelve a responder'); load(true); } }, 'Reactivar asistente'))
        : null,
    );
    if (force || messages.length !== lastCount) {
      lastCount = messages.length;
      fill(chat, ...messages.map((m) => {
        const cls = ['bubble', m.direction === 'in' ? 'in' : 'out', m.sender === 'human' ? 'human' : '', m.status === 'failed' ? 'failed' : ''].join(' ');
        const who = m.sender === 'human' ? '👤 equipo' : m.sender === 'bot' ? '🤖 bot' : '';
        return h('div', { class: cls },
          m.image_id ? h('img', { src: `/api/images/${m.image_id}/file`, alt: m.image_name || '' }) : null,
          m.image_id ? h('div', { class: 'small muted' }, `🖼 ${m.image_code || ''}`) : null,
          m.content || null,
          h('div', { class: 'meta' }, [who, fmtDate(m.created_at), m.status === 'failed' ? '⚠️ no enviado' : '', m.meta?.fallback ? 'respaldo' : ''].filter(Boolean).join(' · ')));
      }));
      chat.scrollTop = chat.scrollHeight;
    }
    if (force || !side.contains(document.activeElement)) drawSide();
  };

  const autoBox = h('div');
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
    const JOB_LABEL = { sequence_step: 'Mensaje de secuencia', no_reply: 'Seguimiento si no responde', automation_send: 'Mensaje programado', appointment_reminder: 'Recordatorio de cita', campaign_send: 'Campaña' };
    fill(autoBox,
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'Citas'),
        upcoming.length ? upcoming.map((a) => h('div', { class: 'small' }, a.kind === 'call' ? '📞 ' : '📅 ', h('strong', {}, a.service_name), ` · ${fmtDate(a.starts_at)}`)) : h('p', { class: 'small muted', style: 'margin:0' }, 'Sin citas próximas'),
        services.length ? h('details', { style: 'margin-top:8px' }, h('summary', {}, 'Agendar cita o llamada'),
          field('Servicio', select(book, 'service_id', services.filter((q) => q.active).map((q) => [q.id, q.name]), loadSlots)),
          slotBox,
          field('Notas', text(book, 'notes')),
          h('button', { class: 'small primary', onclick: async () => { if (await run(() => api('POST', '/api/appointments', { ...book, conversation_id: id }), 'Agendada: se envió la confirmación al cliente')) { drawAuto(); load(true); } } }, 'Agendar y avisar al cliente')) : null),
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'Secuencias'),
        active.length ? active.map((e) => h('div', { class: 'row between small' }, h('span', {}, `▶ ${e.sequence_name} (paso ${e.current_step + 1})`),
          h('button', { class: 'small danger', onclick: async () => { await run(() => api('DELETE', `/api/conversations/${id}/sequences/${e.sequence_id}`), 'Detenida'); drawAuto(); } }, 'Detener'))) : h('p', { class: 'small muted', style: 'margin:0' }, 'Ninguna en curso'),
        seqs.length ? h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { style: 'flex:1' }, select(enr, 'sequence_id', seqs.filter((q) => q.active).map((q) => [q.id, q.name]))),
          h('button', { class: 'small', onclick: async () => { if (await run(() => api('POST', `/api/conversations/${id}/sequences`, enr), 'Inscrito en la secuencia')) drawAuto(); } }, 'Iniciar')) : null,
        auto.jobs.length ? h('details', { style: 'margin-top:8px' }, h('summary', {}, `Envíos programados (${auto.jobs.length})`),
          auto.jobs.map((j) => h('div', { class: 'small muted' }, `${fmtDate(j.run_at)} · ${JOB_LABEL[j.type] || j.type}`))) : null),
    );
    if (services.length) loadSlots();
  };

  const drawSide = () => {
    const { conversation: c, contact: ct } = data;
    const m = { name: ct.name, data: { ...ct.data }, notes: [...(ct.notes || [])], tags: [...(ct.tags || [])], opted_out: !!ct.opted_out };
    const fieldsDef = data.chatbot?.data_fields || [];
    // Los campos de tipo "nombre" se editan en el campo Nombre del contacto.
    const nameKeys = [...new Set([...fieldsDef.filter((f) => f.type === 'name').map((f) => f.key), ...['nombre', 'name'].filter((k) => Object.hasOwn(ct.data || {}, k))])];
    const keys = [...new Set([...fieldsDef.map((f) => f.key), ...Object.keys(ct.data || {})])].filter((k) => !nameKeys.includes(k) && !(ct.name && ['nombre', 'name'].includes(k)));
    fill(side, 
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'Datos del cliente'),
        field('Nombre', text(m, 'name')),
        ...keys.map((k) => field(fieldsDef.find((f) => f.key === k)?.label || dataLabel(k), text(m.data, k))),
        field('Notas (memoria)', lines(m, 'notes')),
        field('Etiquetas', h('input', { type: 'text', value: m.tags.join(', '), placeholder: 'vip, interesado', oninput: (e) => (m.tags = e.target.value.split(',').map((x) => x.trim()).filter(Boolean)) }), 'Separadas por comas. Sirven para campañas y reglas.'),
        check(m, 'opted_out', 'Dado de baja (no recibe mensajes promocionales)'),
        h('button', { class: 'small', onclick: async () => { if (await run(() => api('PUT', `/api/contacts/${ct.id}`, { ...m, data: Object.fromEntries(Object.entries({ ...m.data, ...Object.fromEntries(nameKeys.map((k) => [k, m.name])) }).filter(([, v]) => v)) }), 'Datos guardados')) load(true); } }, 'Guardar datos')),
      flowCard(data.chatbot?.flow, c),
      autoBox,
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, 'Resumen de la conversación'),
          h('button', { class: 'small primary', onclick: async (e) => {
            e.target.disabled = true;
            try { if (await run(() => api('POST', `/api/conversations/${id}/summary`), 'Resumen actualizado')) await load(true); }
            finally { e.target.disabled = false; }
          } }, c.report_summary ? 'Actualizar resumen' : 'Generar resumen')),
        h('p', { class: 'small pre' }, c.report_summary || 'Se genera al cerrar, completar el objetivo o transferir la conversación. Puedes pedirlo en cualquier momento.'),
        c.report_at ? h('p', { class: 'small muted' }, `Generado: ${fmtDate(c.report_at)}`, c.report_until_id < (data.messages.filter((m) => m.status === 'ok').at(-1)?.id || 0) || c.report_data_version !== c.data_version ? ' · Hay información nueva; actualiza el resumen.' : '') : null,
        h('details', { class: 'small' }, h('summary', {}, 'Datos guardados en esta conversación'), h('div', { class: 'pre' }, Object.entries(c.data || {}).map(([key, value]) => `${key}: ${value}`).join('\n') || 'Aún no se han recopilado datos.')),
        c.summary ? h('details', { class: 'small' }, h('summary', {}, 'Memoria del asistente'), h('div', { class: 'pre muted' }, c.summary)) : null,
        h('button', { class: 'small danger', style: 'margin-top:10px', onclick: async () => { if (confirm('¿Borrar memoria (resumen, datos y notas) de este cliente?')) { await run(() => api('POST', `/api/conversations/${id}/reset-memory`), 'Memoria borrada'); load(true); } } }, 'Borrar memoria')),
      isAdmin() ? h('div', { class: 'card' }, h('a', { href: `#/logs?conversation_id=${id}` }, 'Ver registros de esta conversación →')) : null,
    );
  };

  root.append(
    h('a', { href: '#/conversations' }, '← Conversaciones'),
    header,
    h('div', { class: 'split' },
      h('div', { class: 'card' }, chat, h('div', { class: 'composer' }, input, h('button', { onclick: togglePhotos, title: 'Enviar una foto del catálogo' }, '📷 Foto'), h('button', { class: 'primary', onclick: send }, 'Enviar')),
        gallery,
        h('p', { class: 'muted small' }, 'Al enviar un mensaje o una foto a mano, el bot se pausa en esta conversación hasta que la devuelvas.')),
      side),
  );
  await load(true);
  drawAuto().catch(() => undefined);
  state.timers.push(setInterval(() => load().catch(() => undefined), 5000));
}
