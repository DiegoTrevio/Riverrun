import { api, confirmAction, field, fill, fmtDate, h, run, select, state, toast } from './core.js';
import { icon, networkIcon } from './icons.js';
import { render } from './main.js';
import { isAdmin, withAcct } from './session.js';

/**
 * Comentarios y reseñas de las redes conectadas (Instagram, Facebook, X, LinkedIn, YouTube, Google…). Quien atiende los
 * contesta, oculta o responde en privado; la IA sugiere la respuesta con la información del negocio.
 */

const STATUS = { nuevo: ['orange', 'Pendiente'], respondido: ['green', 'Respondido'], oculto: ['', 'Oculto'], eliminado: ['red', 'Eliminado'], ignorado: ['', 'Ignorado'] };
const SENTIMENT = { positive: ['green', 'Positivo'], neutral: ['', 'Neutral'], negative: ['red', 'Negativo'] };
const SOURCE = { human: 'por una persona', suggested: 'con la sugerencia de la IA', auto: 'automáticamente', external: 'desde la red' };
const label = (platform) => (state.meta.social_capabilities || []).find((n) => n.id === platform)?.label || platform;
/** Calificación como cinco estrellas de línea: las ganadas, llenas. */
const stars = (n) => (n ? h('span', { class: 'stars', role: 'img', 'aria-label': `${n} de 5 estrellas` }, [1, 2, 3, 4, 5].map((i) => h('span', { class: i <= n ? 'on' : '' }, icon('star', 14)))) : 'Sin calificación');
/** Enlaces de la red: solo http(s). */
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

export async function viewSocialInbox(root, params) {
  root.append(h('h1', {}, 'Comentarios y reseñas'));
  if (!state.meta.zernio_enabled) {
    root.append(h('p', { class: 'banner warn' }, 'Las redes sociales no están activadas en esta instalación. Pide al administrador de la plataforma que configure Zernio.'));
    return;
  }
  const f = { tipo: params.get('tipo') || 'all', estado: params.get('estado') || 'pendientes', red: params.get('red') || '' };
  const go = () => {
    const q = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && !(k === 'tipo' && v === 'all') && !(k === 'estado' && v === 'pendientes')));
    location.hash = `#/comentarios${q.toString() ? `?${q}` : ''}`;
  };
  const q = new URLSearchParams({ type: f.tipo, status: f.estado, ...(f.red ? { platform: f.red } : {}) });
  const data = await api('GET', withAcct(`/api/social-inbox?${q}`));
  if (!root.isConnected) return;
  const nets = (state.meta.social_capabilities || []).filter((n) => n.comments || n.reviews);
  root.append(
    h('p', { class: 'muted' }, `Lo que la gente comenta en tus publicaciones y las reseñas de tu negocio. Pendientes: ${data.pending.comments} comentario(s) y ${data.pending.reviews} reseña(s).`),
    h('div', { class: 'row wrap', style: 'gap:12px;align-items:flex-end' },
      field('Qué ver', select(f, 'tipo', [['all', 'Todo'], ['comment', 'Comentarios'], ['review', 'Reseñas']], go)),
      field('Estado', select(f, 'estado', [['pendientes', 'Pendientes'], ['respondido', 'Respondidos'], ['oculto', 'Ocultos'], ['ignorado', 'Ignorados'], ['eliminado', 'Eliminados'], ['todos', 'Todos']], go)),
      field('Red', select(f, 'red', [['', 'Todas'], ...nets.map((n) => [n.id, n.label])], go)),
      isAdmin() ? h('button', { class: 'secondary', onclick: async () => {
        const r = await run(() => api('POST', withAcct('/api/social-inbox/sync')));
        if (!r) return;
        toast(r.failed ? `Se revisaron tus redes, menos ${r.failed} que no respondieron` : 'Listo: se revisaron tus redes', !!r.failed);
        render();
      } }, 'Revisar ahora') : null,
      isAdmin() ? h('a', { href: '#/redes', class: 'small' }, 'Respuestas automáticas y avisos →') : null));
  if (!data.items.length) {
    root.append(h('div', { class: 'card empty' }, h('p', {}, f.estado === 'pendientes' ? 'No hay nada pendiente.' : 'No hay nada con estos filtros.'),
      h('p', { class: 'small muted' }, 'Los comentarios nuevos llegan solos en cuanto alguien escribe; X y las reseñas de Facebook se revisan una vez al día.')));
    return;
  }
  root.append(h('div', { class: 'stack' }, data.items.map((item) => card(item))));
}

function card(item) {
  const box = h('div', { class: 'card social-item' });
  const draw = (it) => fill(box, ...content(it, (next) => draw(next)));
  draw(item);
  return box;
}

function content(it, redraw) {
  const comment = it.kind === 'comment';
  const [color, status] = STATUS[it.status] || ['', it.status];
  const sentiment = it.sentiment ? SENTIMENT[it.sentiment] : null;
  const m = { text: it.suggestion || '' };
  let suggested = it.suggestion || '';
  const warn = h('p', { class: 'small', role: 'status' });
  const box = h('textarea', { rows: 3, maxlength: 2000, value: m.text, placeholder: comment ? 'Escribe la respuesta pública…' : 'Escribe la respuesta a la reseña…', oninput: (e) => (m.text = e.target.value) });
  const base = `/api/social-${comment ? 'comments' : 'reviews'}/${it.id}`;
  const act = async (path, body, okMsg) => {
    const r = await run(() => api('POST', withAcct(`${base}/${path}`), body), okMsg);
    if (r) redraw(r);
  };
  const open = it.status === 'nuevo';
  const can = it.can || {};
  const author = it.author.name || (it.author.username ? `@${it.author.username}` : 'Alguien');
  return [
    h('div', { class: 'row between wrap' },
      h('div', { style: 'min-width:0' },
        h('strong', { class: 'with-icon' }, networkIcon(it.platform, 16), label(it.platform)),
        h('span', { class: 'small muted' }, `${it.account_username ? ` · @${it.account_username}` : ''} · ${fmtDate(it.created_at)}`)),
      h('div', { class: 'row', style: 'gap:6px' },
        it.needs_human ? h('span', { class: 'badge red' }, 'Revísalo en persona') : null,
        sentiment && sentiment[1] !== 'Neutral' ? h('span', { class: `badge ${sentiment[0]}` }, sentiment[1]) : null,
        h('span', { class: `badge ${color}` }, status))),
    comment && (it.post.caption || it.post.url) ? h('div', { class: 'row social-post', style: 'gap:10px;margin-top:8px' },
      safeUrl(it.post.thumbnail) ? h('img', { src: safeUrl(it.post.thumbnail), alt: '', width: 48, height: 48, loading: 'lazy', style: 'object-fit:cover;border-radius:6px;flex:none', referrerpolicy: 'no-referrer' }) : null,
      h('div', { style: 'min-width:0' },
        h('p', { class: 'small muted', style: 'margin:0;overflow-wrap:anywhere' }, it.post.caption ? `En: ${it.post.caption.slice(0, 140)}${it.post.caption.length > 140 ? '…' : ''}` : 'En una publicación'),
        safeUrl(it.post.url) ? h('a', { href: safeUrl(it.post.url), target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Ver en la red') : null)) : null,
    !comment ? h('p', { class: 'small' }, stars(it.rating), it.location ? h('span', { class: 'muted' }, ` · ${it.location}`) : null,
      safeUrl(it.url) ? h('span', {}, ' · ', h('a', { href: safeUrl(it.url), target: '_blank', rel: 'noopener noreferrer' }, 'Ver en la red')) : null) : null,
    h('p', { style: 'white-space:pre-wrap;margin:10px 0;overflow-wrap:anywhere' }, h('strong', {}, `${author}: `), it.text || '(sin texto)'),
    it.reply_text ? h('div', { class: 'note' }, h('span', { class: 'small muted' }, `Respuesta ${SOURCE[it.reply_source] || ''}${it.replied_by ? ` (${it.replied_by})` : ''}${it.replied_at ? ` · ${fmtDate(it.replied_at)}` : ''}`),
      h('p', { style: 'white-space:pre-wrap;margin:4px 0 0;overflow-wrap:anywhere' }, it.reply_text)) : null,
    comment && it.private_reply_at ? h('p', { class: 'small muted' }, `Respondido en privado · ${fmtDate(it.private_reply_at)}`) : null,
    open && (comment ? can.reply : true) ? h('div', { class: 'stack', style: 'margin-top:8px' },
      field(comment ? 'Tu respuesta' : 'Respuesta a la reseña', box),
      warn,
      h('div', { class: 'row wrap', style: 'gap:8px' },
        h('button', { class: 'secondary', onclick: async () => {
          const s = await run(() => api('POST', withAcct(`${base}/suggest`)));
          if (!s) return;
          if (s.risk) { warn.textContent = 'Es un mensaje delicado: contéstalo en persona.'; return; }
          suggested = s.reply;
          m.text = s.reply;
          box.value = s.reply;
          warn.textContent = s.unverified?.length ? `Revisa antes de enviar: ${s.unverified.join(', ')} no está en la información de tu agente.`
            : s.needs_human ? 'La IA sugiere que una persona lo revise antes de responder.' : '';
          box.focus();
        } }, 'Sugerir respuesta'),
        h('button', { onclick: () => {
          if (!m.text.trim()) return toast('Escribe la respuesta', true);
          act('reply', { text: m.text, source: m.text === suggested && suggested ? 'suggested' : 'human' }, 'Respuesta publicada');
        } }, 'Responder'),
        comment && can.privateReply && !it.private_reply_at ? h('button', { class: 'secondary', title: 'Le llega como mensaje directo (una sola vez y hasta 7 días después del comentario)', onclick: () => {
          if (!m.text.trim()) return toast('Escribe el mensaje privado', true);
          act('private-reply', { text: m.text }, 'Mensaje privado enviado');
        } }, 'Responder en privado') : null)) : null,
    h('div', { class: 'row wrap', style: 'gap:8px;margin-top:8px' },
      comment && can.hide && ['nuevo', 'respondido'].includes(it.status) ? h('button', { class: 'small secondary', onclick: () => act('hide', undefined, 'Comentario oculto') }, 'Ocultar') : null,
      comment && can.hide && it.status === 'oculto' ? h('button', { class: 'small secondary', onclick: () => act('unhide', undefined, 'Comentario visible otra vez') }, 'Mostrar') : null,
      comment && can.like && it.status !== 'eliminado' ? h('button', { class: 'small secondary', 'aria-pressed': String(!!it.liked), onclick: () => act(it.liked ? 'unlike' : 'like') }, icon('heart', 16), it.liked ? 'Te gusta' : 'Me gusta') : null,
      it.status === 'nuevo' ? h('button', { class: 'small secondary', onclick: () => act('ignore', undefined, 'Quitado de pendientes') }, 'No requiere respuesta') : null,
      it.status === 'ignorado' ? h('button', { class: 'small secondary', onclick: () => act('unignore') }, 'Volver a pendientes') : null,
      comment && can.delete && isAdmin() && it.status !== 'eliminado' ? h('button', { class: 'small danger', onclick: async () => {
        if (!(await confirmAction(`¿Eliminar el comentario de ${author} en ${label(it.platform)}? Se borra de la red y no se puede deshacer.`))) return;
        const r = await run(() => api('DELETE', withAcct(base)), 'Comentario eliminado');
        if (r) redraw(r);
      } }, 'Eliminar') : null),
  ];
}
