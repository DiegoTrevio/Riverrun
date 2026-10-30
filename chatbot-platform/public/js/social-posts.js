import { api, confirmAction, field, fill, h, poll, run, state, toast } from './core.js';
import { icon, networkIcon } from './icons.js';
import { render } from './main.js';
import { withAcct } from './session.js';

/**
 * Publicaciones en tus redes (Zernio): escribe una vez, elige las cuentas y publica ya o programa. Cada red muestra su
 * estado y su enlace; lo que falla se puede reintentar.
 */

const STATUS = {
  borrador: ['', 'Borrador'], enviando: ['orange', 'Enviando…'], programada: ['', 'Programada'], publicando: ['orange', 'Publicando…'],
  publicada: ['green', 'Publicada'], parcial: ['orange', 'Salió en algunas redes'], fallida: ['red', 'No salió'], cancelada: ['', 'Cancelada'],
};
/** Estado de cada red de una publicación, como insignia (color y palabra). */
const TARGET = { pendiente: ['', 'Pendiente'], publicando: ['', 'Publicando'], publicada: ['green', 'Publicada'], fallida: ['red', 'Falló'], cancelada: ['', 'Cancelada'], eliminada: ['', 'Eliminada'] };
const label = (platform) => (state.meta.social_capabilities || []).find((n) => n.id === platform)?.label || platform;
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const graphemes = (t) => {
  try { return [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(t)].length; } catch { return [...t].length; }
};
const dayKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const upperFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const dayLabel = (iso, tz) => upperFirst(new Intl.DateTimeFormat('es-MX', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)));
const timeLabel = (iso, tz) => new Intl.DateTimeFormat('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const whenOf = (p) => p.scheduled_for || p.published_at || p.created_at;

export async function viewSocialPosts(root, sub, params) {
  if (!state.meta.zernio_enabled) {
    root.append(h('h1', {}, 'Publicaciones'), h('p', { class: 'banner warn' }, 'Las redes sociales no están activadas en esta instalación. Pide al administrador de la plataforma que configure Zernio.'));
    return;
  }
  if (sub === 'nueva' || (sub && sub !== 'calendario')) return compose(root, sub === 'nueva' ? null : sub, params);
  return list(root, params);
}

/* ------------------------------ Lista y calendario ------------------------------ */

async function list(root, params) {
  const month = /^\d{4}-\d{2}$/.test(params.get('mes') || '') ? params.get('mes') : '';
  const calendar = params.get('vista') === 'calendario';
  const data = await api('GET', withAcct(`/api/social-publications${month ? `?month=${month}` : ''}`));
  if (!root.isConnected) return;
  const tz = data.timezone;
  const thisMonth = dayKey(new Date().toISOString(), tz).slice(0, 7);
  const shown = month || thisMonth;
  const shift = (n) => {
    const [y, m] = shown.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const go = (q) => { location.hash = `#/publicaciones${q ? `?${q}` : ''}`; };
  root.append(
    h('div', { class: 'row between wrap', style: 'gap:12px' },
      h('h1', { style: 'margin:0' }, 'Publicaciones'),
      data.accounts.length ? h('a', { class: 'btn primary', href: '#/publicaciones/nueva' }, '+ Nueva publicación') : null),
    h('p', { class: 'muted' }, `Escribe una vez y publícala en tus redes, ya o a la hora que quieras (horario de tu negocio: ${tz}).`));
  if (!data.accounts.length) {
    root.append(h('div', { class: 'card' }, h('p', {}, 'Conecta Instagram, Facebook, LinkedIn, TikTok, YouTube u otra red para publicar desde aquí.'), h('a', { class: 'btn', href: '#/redes' }, 'Conectar redes')));
    if (!data.items.length) return;
  }
  const monthName = (k) => upperFirst(new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${k}-15T12:00:00Z`)));
  root.append(h('div', { class: 'row wrap', style: 'gap:8px;align-items:center;margin:8px 0' },
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'Cómo ver' },
      h('button', { class: calendar ? 'secondary small' : 'small', 'aria-pressed': String(!calendar), onclick: () => go(month ? `mes=${month}` : '') }, 'Lista'),
      h('button', { class: calendar ? 'small' : 'secondary small', 'aria-pressed': String(calendar), onclick: () => go(`vista=calendario&mes=${shown}`) }, 'Calendario')),
    month || calendar ? h('div', { class: 'row', style: 'gap:6px;align-items:center' },
      h('button', { class: 'small secondary', 'aria-label': 'Mes anterior', onclick: () => go(`${calendar ? 'vista=calendario&' : ''}mes=${shift(-1)}`) }, '←'),
      h('strong', {}, monthName(shown)),
      h('button', { class: 'small secondary', 'aria-label': 'Mes siguiente', onclick: () => go(`${calendar ? 'vista=calendario&' : ''}mes=${shift(1)}`) }, '→'),
      !calendar ? h('button', { class: 'small secondary', onclick: () => go('') }, 'Ver lo reciente') : null)
      : h('button', { class: 'small secondary', onclick: () => go(`mes=${thisMonth}`) }, 'Ver por mes')));

  if (calendar) {
    if (!month) return go(`vista=calendario&mes=${shown}`);
    root.append(monthGrid(shown, data.items, tz));
  }
  const items = calendar && params.get('dia') ? data.items.filter((p) => dayKey(whenOf(p), tz) === params.get('dia')) : data.items;
  if (!items.length) {
    root.append(h('div', { class: 'card empty' }, h('p', {}, calendar && params.get('dia') ? 'No hay publicaciones ese día.' : 'Todavía no hay publicaciones aquí.')));
    return;
  }
  // Agrupadas por día (lo programado primero, en orden).
  const groups = new Map();
  for (const p of [...items].sort((a, b) => Date.parse(whenOf(b)) - Date.parse(whenOf(a)))) {
    const k = dayKey(whenOf(p), tz);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const box = h('div', { class: 'stack' });
  for (const [, ps] of groups) {
    box.append(h('h2', { class: 'small muted', style: 'margin:16px 0 4px' }, dayLabel(whenOf(ps[0]), tz)), ...ps.map((p) => card(p, tz)));
  }
  root.append(box);
  // Mientras algo se está enviando, se actualiza solo.
  if (data.items.some((p) => p.status === 'enviando' || p.status === 'publicando')) poll(async () => { render(); }, 10000, root);
}

function monthGrid(month, items, tz) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7; // lunes primero
  const byDay = new Map();
  for (const p of items) {
    const k = dayKey(whenOf(p), tz);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(h('div', { class: 'cal-cell empty', 'aria-hidden': 'true' }));
  for (let d = 1; d <= days; d++) {
    const k = `${month}-${String(d).padStart(2, '0')}`;
    const ps = byDay.get(k) || [];
    cells.push(h('button', {
      class: `cal-cell${ps.length ? ' has' : ''}`, 'aria-label': `${d}: ${ps.length} publicación${ps.length === 1 ? '' : 'es'}`,
      onclick: () => { location.hash = `#/publicaciones?vista=calendario&mes=${month}&dia=${k}`; },
    }, h('span', { class: 'cal-day' }, String(d)),
    ps.slice(0, 3).map((p) => h('span', { class: `cal-item ${STATUS[p.status]?.[0] || ''}` }, `${timeLabel(whenOf(p), tz)} `, p.targets.map((t) => networkIcon(t.platform, 12)))),
    ps.length > 3 ? h('span', { class: 'small muted' }, `+${ps.length - 3}`) : null));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'post-cal-grid', 'aria-hidden': 'true' }, ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'].map((d) => h('span', { class: 'post-cal-head' }, d))),
    h('div', { class: 'post-cal-grid' }, cells));
}

function card(p, tz) {
  const [color, status] = STATUS[p.status] || ['', p.status];
  const act = async (fn, okMsg) => { if (await run(fn, okMsg)) render(); };
  return h('div', { class: 'card social-publication' },
    h('div', { class: 'row between wrap', style: 'gap:8px' },
      h('strong', {}, `${p.status === 'programada' || p.status === 'borrador' ? (p.scheduled_for ? icon('clock', 14) : '') : ''}${timeLabel(whenOf(p), tz)}`),
      h('span', { class: `badge ${color}` }, status)),
    h('div', { class: 'row', style: 'gap:10px;margin-top:8px;align-items:flex-start' },
      p.media[0] && safeUrl(p.media[0].url) ? (p.media[0].type === 'image'
        ? h('img', { src: safeUrl(p.media[0].url), alt: '', width: 64, height: 64, loading: 'lazy', style: 'object-fit:cover;border-radius:6px;flex:none', referrerpolicy: 'no-referrer' })
        : h('span', { class: 'net-icon', style: 'flex:none' }, icon('video', 28))) : null,
      h('p', { style: 'white-space:pre-wrap;margin:0;overflow-wrap:anywhere;min-width:0' }, p.text ? `${p.text.slice(0, 280)}${p.text.length > 280 ? '…' : ''}` : '(sin texto)')),
    h('ul', { class: 'plain', style: 'margin:8px 0 0;padding:0;list-style:none' }, p.targets.map((t) => h('li', { class: 'small', style: 'overflow-wrap:anywhere' },
      TARGET[t.status] ? [h('span', { class: `badge ${TARGET[t.status][0]}` }, TARGET[t.status][1]), ' '] : null, h('span', { class: 'with-icon' }, networkIcon(t.platform, 14), `${label(t.platform)}${t.username ? ` @${t.username}` : ''}`),
      safeUrl(t.url) ? h('span', {}, ' · ', h('a', { href: safeUrl(t.url), target: '_blank', rel: 'noopener noreferrer' }, 'Ver en la red')) : null,
      t.error ? h('span', { class: 'error' }, ` · ${t.error}`) : null))),
    p.error ? h('p', { class: 'small error' }, p.error) : null,
    h('div', { class: 'row wrap', style: 'gap:8px;margin-top:8px' },
      p.can.edit ? h('a', { class: 'btn small', href: `#/publicaciones/${p.id}` }, 'Editar') : null,
      p.can.retry ? h('button', { class: 'small', onclick: () => act(() => api('POST', withAcct(`/api/social-publications/${p.id}/retry`)), 'Se volvió a intentar') }, 'Reintentar') : null,
      h('a', { class: 'btn small secondary', href: `#/publicaciones/nueva?copiar=${p.id}` }, 'Duplicar'),
      p.can.cancel && p.status === 'programada' ? h('button', { class: 'small secondary', onclick: async () => {
        if (await confirmAction('¿Cancelar esta publicación programada? No saldrá en ninguna red.')) act(() => api('POST', withAcct(`/api/social-publications/${p.id}/cancel`)), 'Publicación cancelada');
      } }, 'Cancelar') : null,
      p.can.delete ? h('button', { class: 'small danger', onclick: async () => {
        if (await confirmAction(p.status === 'publicada' || p.status === 'parcial' ? '¿Quitarla de esta lista? En las redes sigue publicada.' : '¿Borrar esta publicación?')) act(() => api('DELETE', withAcct(`/api/social-publications/${p.id}`)), 'Borrada');
      } }, p.status === 'borrador' ? 'Borrar' : 'Quitar de la lista') : null));
}

/* ------------------------------ Escribir ------------------------------ */

async function compose(root, id, params) {
  const copyFrom = params.get('copiar');
  const [data, existing] = await Promise.all([
    api('GET', withAcct('/api/social-publications?month=1970-01')),
    id || copyFrom ? api('GET', withAcct(`/api/social-publications/${id || copyFrom}`)) : null,
  ]);
  if (!root.isConnected) return;
  const tz = data.timezone;
  const rules = data.rules;
  const editing = !!id;
  if (editing && !existing.can.edit) {
    root.append(h('a', { href: '#/publicaciones', class: 'breadcrumb' }, '← Publicaciones'), h('p', { class: 'banner warn' }, 'Esta publicación ya no se puede cambiar.'));
    return;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const local = existing?.scheduled_for && editing ? new Date(existing.scheduled_for) : null;
  const inTz = (d, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts }).format(d);
  const m = {
    client_ref: crypto.randomUUID(),
    text: existing?.text || '',
    // Zernio borra los archivos de una publicación cancelada: al duplicarla hay que volver a subirlos.
    media: existing?.status === 'cancelada' && !editing ? [] : [...(existing?.media || [])],
    selected: new Set((existing?.targets || []).map((t) => t.social_account_id).filter((x) => data.accounts.some((a) => a.id === x))),
    custom: Object.fromEntries((existing?.targets || []).map((t) => [t.social_account_id, t.text || ''])),
    options: Object.fromEntries((existing?.targets || []).map((t) => [t.social_account_id, { ...(t.options || {}) }])),
    mode: editing && existing.status === 'programada' ? 'schedule' : 'now',
    // Un borrador guarda su fecha solo si se eligió una (al programar o porque ya la tenía).
    keepDate: !!(editing && existing.scheduled_for),
    uploading: 0,
    date: local ? inTz(local, { year: 'numeric', month: '2-digit', day: '2-digit' }) : inTz(new Date(Date.now() + 86400_000), { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: local ? `${pad(Number(inTz(local, { hour: '2-digit', hour12: false })) % 24)}:${inTz(local, { minute: '2-digit' }).padStart(2, '0')}` : '10:00',
  };
  if (!m.selected.size && data.accounts.length === 1) m.selected.add(data.accounts[0].id);
  root.append(h('a', { href: '#/publicaciones', class: 'breadcrumb' }, '← Publicaciones'), h('h1', {}, editing ? 'Editar publicación' : 'Nueva publicación'));
  const gone = (existing?.targets || []).filter((t) => !data.accounts.some((a) => a.id === t.social_account_id));
  if (gone.length) root.append(h('p', { class: 'banner warn' }, `Ya no está conectada: ${gone.map((t) => `${label(t.platform)}${t.username ? ` @${t.username}` : ''}`).join(', ')}. Se quitará de esta publicación.`));
  if (copyFrom && existing?.status === 'cancelada' && existing.media.length) root.append(h('p', { class: 'small muted' }, 'Vuelve a subir las fotos o el video: los de una publicación cancelada ya no están disponibles.'));
  if (!data.accounts.length) {
    root.append(h('p', { class: 'banner warn' }, 'Primero conecta una red en Ajustes → Redes sociales.'));
    return;
  }

  const counters = h('div', { class: 'row wrap', style: 'gap:6px', 'aria-live': 'polite' });
  const extras = h('div', { class: 'stack' });
  const mediaList = h('div', { class: 'row wrap', style: 'gap:8px' });
  const issues = h('ul', { class: 'error small', role: 'alert' });
  const chosen = () => data.accounts.filter((a) => m.selected.has(a.id));
  const drawCounters = () => fill(counters, ...chosen().map((a) => {
    const r = rules[a.platform] || { max: 2200 };
    const n = graphemes((m.custom[a.id] || '').trim() ? m.custom[a.id] : m.text);
    const over = n > r.max;
    const warn = !over && r.warnAbove && n > r.warnAbove;
    const needs = r.mediaRequired === 'video' ? !m.media.some((x) => x.type === 'video') : r.mediaRequired === 'any' ? !m.media.length : false;
    return h('span', { class: `badge ${over || needs ? 'red' : warn ? 'orange' : ''}`, title: needs ? (r.mediaRequired === 'video' ? 'Necesita un video' : 'Necesita una foto o un video') : '' },
      networkIcon(a.platform, 12), ` ${n}/${warn ? r.warnAbove : r.max}${needs ? (r.mediaRequired === 'video' ? ' · falta video' : ' · falta foto') : ''}`);
  }));
  const drawExtras = () => fill(extras, ...chosen().map((a) => {
    const r = rules[a.platform] || {};
    m.options[a.id] = m.options[a.id] || {};
    const o = m.options[a.id];
    return h('details', { open: !!((m.custom[a.id] || '').trim() || o.title || o.link) },
      h('summary', {}, `Personalizar para ${label(a.platform)}${a.username ? ` (@${a.username})` : ''}`),
      h('div', { class: 'stack', style: 'margin-top:6px' },
        field('Texto solo para esta red (vacío: el de arriba)', h('textarea', { rows: 3, value: m.custom[a.id] || '', oninput: (e) => { m.custom[a.id] = e.target.value; drawCounters(); } })),
        r.title ? field(`Título (hasta ${r.title} caracteres)`, h('input', { maxlength: r.title, value: o.title || '', oninput: (e) => (o.title = e.target.value) })) : null,
        r.link ? field('Enlace de destino', h('input', { type: 'url', placeholder: 'https://', value: o.link || '', oninput: (e) => (o.link = e.target.value) })) : null));
  }));
  const drawMedia = () => fill(mediaList, ...m.media.map((x, i) => h('div', { class: 'media-chip row', style: 'gap:6px;align-items:center' },
    x.type === 'image' && safeUrl(x.url) ? h('img', { src: safeUrl(x.url), alt: '', width: 48, height: 48, style: 'object-fit:cover;border-radius:6px', referrerpolicy: 'no-referrer' }) : h('span', { class: 'net-icon' }, icon('video', 24)),
    h('span', { class: 'small', style: 'max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, x.name || (x.type === 'image' ? 'Foto' : 'Video')),
    h('button', { class: 'small secondary', 'aria-label': `Quitar ${x.name || 'archivo'}`, onclick: () => { m.media.splice(i, 1); drawMedia(); drawCounters(); } }, icon('x', 14)))));

  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,video/mp4', multiple: true, onchange: async (e) => {
    // Mientras sube no se puede publicar (saldría sin ese archivo).
    m.uploading++;
    save.disabled = true;
    try {
      for (const file of [...e.target.files]) {
        const fd = new FormData();
        fd.append('file', file, file.name);
        const r = await run(() => api('POST', withAcct('/api/social-media'), fd, true));
        if (r) m.media.push(r);
      }
    } finally {
      m.uploading--;
      save.disabled = m.uploading > 0;
    }
    e.target.value = '';
    drawMedia();
    drawCounters();
  } });

  const accountsBox = h('div', { class: 'stack' }, data.accounts.map((a) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: m.selected.has(a.id), onchange: (e) => { if (e.target.checked) m.selected.add(a.id); else m.selected.delete(a.id); drawCounters(); drawExtras(); } }),
    ' ', networkIcon(a.platform, 16), ` ${label(a.platform)}${a.username ? ` · @${a.username}` : a.display_name ? ` · ${a.display_name}` : ''}`)));

  const whenBox = h('div', { class: 'stack' });
  const save = h('button', { class: 'primary' });
  const drawWhen = () => {
    save.textContent = m.mode === 'now' ? 'Publicar ahora' : m.mode === 'schedule' ? 'Programar' : 'Guardar borrador';
    fill(whenBox,
      h('div', { class: 'row wrap', role: 'radiogroup', 'aria-label': 'Cuándo', style: 'gap:12px' },
        [['now', 'Publicar ahora'], ['schedule', 'Programar'], ['draft', 'Guardar como borrador']].map(([v, l]) => h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'mode', value: v, checked: m.mode === v, onchange: () => { m.mode = v; if (v === 'schedule') m.keepDate = true; drawWhen(); } }), ` ${l}`))),
      m.mode === 'schedule' ? h('div', { class: 'row wrap', style: 'gap:12px' },
        field('Fecha', h('input', { type: 'date', value: m.date, oninput: (e) => (m.date = e.target.value) })),
        field(`Hora (${tz})`, h('input', { type: 'time', value: m.time, oninput: (e) => (m.time = e.target.value) }))) : null,
      m.selected.size && chosen().some((a) => a.platform === 'tiktok') ? h('p', { class: 'small muted' }, 'TikTok: llega a la bandeja de tu cuenta de TikTok y lo terminas de publicar en la app.') : null);
  };
  save.onclick = async () => {
    fill(issues);
    const body = {
      client_ref: m.client_ref, mode: m.mode, text: m.text, media: m.media, ...(m.mode === 'schedule' || (m.mode === 'draft' && m.keepDate) ? { date: m.date, time: m.time } : {}),
      targets: chosen().map((a) => ({ social_account_id: a.id, text: (m.custom[a.id] || '').trim() ? m.custom[a.id] : null, options: m.options[a.id] || {} })),
      ...(editing ? { version: existing.version } : {}),
    };
    if (m.uploading) return toast('Espera a que terminen de subir los archivos', true);
    save.disabled = true;
    try {
      const r = await api(editing ? 'PUT' : 'POST', withAcct(editing ? `/api/social-publications/${id}` : '/api/social-publications'), body);
      for (const w of r.warnings || []) toast(w);
      toast(r.status === 'publicada' ? 'Publicada' : r.status === 'programada' ? 'Programada' : r.status === 'borrador' ? 'Borrador guardado' : r.status === 'parcial' ? 'Salió en algunas redes: revisa cuál falló' : r.status === 'enviando' ? 'Enviando… te avisamos si algo falla' : 'Listo', r.status === 'parcial');
      location.hash = '#/publicaciones';
    } catch (e) {
      // Lo que falta, sin la clave interna del campo («targets: …») ni repetido en el aviso.
      const list = (e?.data?.issues || e?.issues || []).map((x) => String(x).replace(/^[\w.[\]]+: /, ''));
      fill(issues, ...(list.length ? list : [e?.message || 'No se pudo guardar']).map((x) => h('li', {}, x)));
      toast(list.length ? list.join(' · ') : e?.message || 'No se pudo guardar', true);
    } finally {
      save.disabled = false;
    }
  };

  const textBox = h('textarea', { rows: 6, value: m.text, placeholder: '¿Qué quieres publicar?', oninput: (e) => { m.text = e.target.value; drawCounters(); } });
  root.append(h('div', { class: 'card stack' },
    field('Dónde', accountsBox),
    field('Texto', textBox, 'Cada red tiene su límite; el contador se pone en rojo si te pasas.'),
    counters,
    field('Fotos o video', fileInput, 'JPG, PNG, WEBP o MP4 (hasta 16 MB cada uno). Instagram y TikTok necesitan al menos una; YouTube, un video.'),
    mediaList,
    extras,
    whenBox,
    issues,
    h('div', { class: 'row' }, save, h('a', { class: 'btn secondary', href: '#/publicaciones' }, 'Volver'))));
  drawCounters();
  drawExtras();
  drawMedia();
  drawWhen();
}
