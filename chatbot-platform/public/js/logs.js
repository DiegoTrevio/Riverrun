import { api, fmtDate, h, select, state } from './core.js';
import { render } from './main.js';
import { isSuper } from './session.js';

/* ------------------------------ Registros ------------------------------ */

export async function viewLogs(root, params) {
  const selected = isSuper() ? params.get('account_id') || state.accountId || '' : '';
  const scoped = selected ? `?account_id=${encodeURIComponent(selected)}` : '';
  const bots = await api('GET', `/api/chatbots${scoped}`);
  const f = { chatbot_id: params.get('chatbot_id') || '', channel_id: params.get('channel_id') || '', level: params.get('level') || '', source: params.get('source') || '', conversation_id: params.get('conversation_id') || '' };
  if (selected) f.account_id = selected;
  const apply = () => { location.hash = `#/logs?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`; };
  const botName = Object.fromEntries(bots.map((b) => [b.id, b.name]));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  if (selected) qs.set('account_id', selected);
  const rows = await api('GET', `/api/logs?${qs}`);
  const supervision = await api('GET', `/api/knowledge/monitor${scoped}`);
  const titles = {pending:'Pendientes sin avance',embedding:'Error de embeddings',fallback:'Búsqueda por palabras',latency:'Latencia alta',cost:'Revisar costos',delivery:'Entregas fallidas',configuration:'Revisar configuración'};
  const monitorCard = h('details', {class:'card',open:true}, h('summary',{},'Supervisión del conocimiento'),
    h('p',{class:'muted small'}, supervision.enabled ? 'Revisión cada 5 minutos · métricas de la última hora · avisos en Notificaciones.' : 'La supervisión automática está desactivada.'),
    supervision.accounts.map(a => {
      const m=a.metrics;
      return h('div',{style:'margin-top:12px'}, h('strong',{},a.name),
        a.checked_at ? h('div',{class:'muted small'},`Última revisión: ${fmtDate(a.checked_at)}`) : h('p',{class:'muted'},'Aún no se ha realizado una revisión.'),
        m ? h('p',{},`Pendientes: ${m.pending_items} · Errores de embeddings: ${m.embedding_errors} · Búsqueda por palabras: ${m.attempts ? (m.fallback_ratio*100).toFixed(1)+'%' : 'sin consultas'} · p95 búsqueda: ${Math.round(m.p95_ms)} ms · p95 embeddings: ${Math.round(m.embedding_p95_ms || 0)} ms · IA registrada: US$${Number(m.recorded_usd).toFixed(4)}`) : null,
        m?.unreported_embedding_costs ? h('p',{class:'muted small'},`${m.unreported_embedding_costs} embeddings sin costo reportado por el proveedor; el total puede incluir estimaciones.`) : null,
        a.alerts.length ? h('div',{},a.alerts.map(alert=>h('span',{class:'badge orange',style:'margin-right:6px'},titles[alert.kind]||'Revisar supervisión'))) : null);
    }));
  root.append(
    h('h1', {}, 'Registros'),
    monitorCard,
    h('div', { class: 'card row' },
      h('div', { style: 'min-width:180px' }, select(f, 'chatbot_id', [['', 'Todos los chatbots'], ...bots.map((b) => [b.id, b.name])], apply)),
      h('div', { style: 'min-width:140px' }, select(f, 'level', [['', 'Todos los niveles'], ['error', 'Errores'], ['warn', 'Advertencias'], ['info', 'Información']], apply)),
      h('div', { style: 'min-width:160px' }, select(f, 'source', [['', 'Todos los componentes'], ['evolution', 'Evolution (WhatsApp)'], ['channel', 'Canales'], ['ai', 'IA'], ['validator', 'Validador'], ['engine', 'Motor'], ['webhook', 'Webhook'], ['admin', 'Panel'], ['system', 'Sistema']], apply)),
      f.conversation_id ? h('span', { class: 'badge' }, 'filtrado por conversación ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); f.conversation_id = ''; apply(); } }, '✕')) : null,
      f.channel_id ? h('span', { class: 'badge' }, 'filtrado por canal ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); f.channel_id = ''; apply(); } }, '✕')) : null,
      h('button', { onclick: render }, 'Actualizar')),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Fecha'), h('th', {}, 'Nivel'), h('th', {}, 'Componente'), h('th', {}, 'Chatbot'), h('th', {}, 'Mensaje'))),
        h('tbody', {}, rows.map((r) =>
          h('tr', { class: `log-${r.level}` },
            h('td', { class: 'small' }, fmtDate(r.created_at)),
            h('td', {}, r.level),
            h('td', {}, r.source),
            h('td', { class: 'small' }, botName[r.chatbot_id] || ''),
            h('td', {}, r.message,
              r.conversation_id ? h('div', {}, h('a', { class: 'small', href: `#/conversation/${r.conversation_id}` }, 'ver conversación')) : null,
              r.details && Object.keys(r.details).length ? h('details', {}, h('summary', {}, 'detalles'), h('pre', { class: 'small pre' }, JSON.stringify(r.details, null, 2))) : null)))))),
  );
}
