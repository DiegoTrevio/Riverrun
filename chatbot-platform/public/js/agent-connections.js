import { channelIcon, connectionBadge, connectionHref } from './channels.js';
import { api, field, fill, h, run, select, state, text, toast } from './core.js';
import { accountName, isSuper } from './session.js';

/** Las conexiones conservan su cuenta, número y conversaciones; solo cambia su agente. */
export function pendingConnections(channels, bots) {
  const pending = channels.filter((c) => !c.chatbot_id && c.type !== 'playground');
  if (!pending.length) return null;
  return h('section', { class: 'card', id: 'pending-connections' },
    h('h2', { style: 'margin-top:0' }, 'Conexiones pendientes de asignar'),
    h('p', { class: 'help' }, 'Estas conexiones siguen guardando mensajes. Asigna un agente para que atienda sus conversaciones.'),
    pending.map((ch) => {
      const choice = { chatbot_id: '' };
      const available = bots.filter((b) => b.account_id === ch.account_id);
      return h('div', { class: 'list-item' },
        h('div', { class: 'row between' }, h('strong', {}, channelIcon(ch.type), ' ', ch.name), connectionBadge(ch)),
        isSuper() ? h('p', { class: 'help' }, accountName(ch.account_id)) : null,
        available.length ? h('div', { class: 'row' },
          field('Agente que responderá', select(choice, 'chatbot_id', [['', 'Elige un agente'], ...available.map((b) => [b.id, b.name])])),
          h('button', { class: 'primary', onclick: async (event) => {
            if (!choice.chatbot_id) return toast('Elige un agente del mismo perfil.', true);
            const button = event.currentTarget;
            button.disabled = true;
            try {
              const assigned = await run(() => api('PUT', `/api/channels/${ch.id}`, { chatbot_id: choice.chatbot_id }), 'Conexión asignada');
              if (assigned) location.hash = `#/bot/${assigned.chatbot_id}/conexiones`;
            } finally { button.disabled = false; }
          } }, 'Asignar')) : h('p', { class: 'help' }, 'Crea un agente en este perfil para asignarle esta conexión.'),
        h('a', { class: 'btn small', href: connectionHref(ch) }, 'Administrar conexión'));
    }));
}

/** La cuenta y el agente vienen de la ficha: no se vuelven a pedir al crear el canal. */
export async function tabConnections(root, bot, params = new URLSearchParams()) {
  const channels = await api('GET', `/api/channels${isSuper() ? `?account_id=${bot.account_id}` : ''}`);
  const accountChannels = channels.filter((c) => c.account_id === bot.account_id && c.type !== 'playground');
  const mine = accountChannels.filter((c) => c.chatbot_id === bot.id);
  const pending = accountChannels.filter((c) => !c.chatbot_id);
  const types = state.meta.channel_types.filter((t) => t.type !== 'playground');
  const limit = state.meta.max_whatsapp_profiles || 4;
  const count = accountChannels.filter((c) => c.type === 'whatsapp').length;
  const draft = { type: 'whatsapp', name: '' };
  const warning = h('p', { class: 'help' });
  const button = h('button', { class: 'primary', onclick: async (event) => {
    const submit = event.currentTarget;
    submit.disabled = true;
    try {
      const created = await run(() => api('POST', '/api/channels', {
        ...draft, name: draft.name.trim() || types.find((t) => t.type === draft.type)?.label || draft.type,
        chatbot_id: bot.id, ...(isSuper() ? { account_id: bot.account_id } : {}),
      }), 'Conexión creada');
      if (created) location.hash = connectionHref(created);
    } finally { updateLimit(); }
  } }, 'Crear y conectar');
  function updateLimit() {
    button.disabled = draft.type === 'whatsapp' && count >= limit;
    fill(warning, button.disabled ? `Ya tienes ${limit} perfiles de WhatsApp en esta cuenta. Puedes asignar uno existente a este agente o administrar sus conexiones.` : 'La conexión queda asignada a este agente. Para WhatsApp, el QR se prepara al abrirla.');
  }
  updateLimit();
  root.append(
    h('p', { class: 'muted' }, `${count} de ${limit} perfiles de WhatsApp en esta cuenta. El mismo agente puede atender varios teléfonos; cada conexión conserva sus conversaciones.`),
    h('details', { class: 'card', open: params.get('new') === '1' || !mine.length },
      h('summary', {}, '+ Conectar teléfono u otro canal'),
      h('div', { class: 'grid' },
        field('Plataforma', select(draft, 'type', types.map((t) => [t.type, t.label]), updateLimit)),
        field('Nombre de la conexión', text(draft, 'name', { placeholder: 'WhatsApp ventas, recepción…', maxlength: 120 }))),
      warning, button),
    pending.length ? pendingConnections(pending, [bot]) : null,
    mine.length ? h('div', { class: 'grid' }, mine.map((ch) => {
      const status = h('span', {}, connectionBadge(ch));
      const refresh = async () => {
        if (ch.type !== 'whatsapp') return;
        try {
          const result = await api('GET', `/api/channels/${ch.id}/status`);
          fill(status, connectionBadge({ ...ch, connection_state: result.state }));
        } catch { fill(status, connectionBadge({ ...ch, connection_state: 'unknown' })); }
      };
      // Leer el estado no prepara un QR ni cambia la asignación.
      refresh();
      return h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, channelIcon(ch.type), ' ', ch.name), status),
        h('p', { class: 'muted' }, ch.label || ch.type, ch.config?.number ? ` · +${ch.config.number}` : ''),
        h('div', { class: 'row' },
          h('a', { class: 'btn primary', href: connectionHref(ch) }, ch.type === 'whatsapp' ? 'Ver QR / administrar' : 'Configurar conexión'),
          h('a', { class: 'btn', href: `#/conversations?channel_id=${ch.id}` }, 'Conversaciones'),
          ch.type === 'whatsapp' ? h('button', { class: 'small', onclick: refresh }, 'Actualizar estado') : null));
    })) : h('div', { class: 'card' }, h('p', {}, 'Este agente todavía no tiene conexiones. Puedes probarlo antes de conectar un teléfono.'), h('a', { class: 'btn', href: `#/bot/${bot.id}/probar` }, 'Probar agente')),
  );
}

/** Compatibilidad con los enlaces anteriores de canales y QR. */
export async function goLegacyConnections(params) {
  if (params.get('channel')) {
    const channel = await api('GET', `/api/channels/${encodeURIComponent(params.get('channel'))}`);
    location.replace(connectionHref(channel));
  } else if (params.get('chatbot_id')) {
    location.replace(`#/bot/${encodeURIComponent(params.get('chatbot_id'))}/conexiones${params.get('new') === '1' ? '?new=1' : ''}`);
  } else location.replace('#/agentes?connections=1');
}
