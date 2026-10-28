import { h } from './core.js';

/** Íconos de línea (24×24) para el menú y la barra superior. Decorativos: el texto de al lado dice qué son. */
const PATHS = {
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>',
  chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 20 12z"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8a5 5 0 0 1 0 8M18 5a9 9 0 0 1 0 14"/>',
  comments: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M8 8h9M8 12h6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  pipeline: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/>',
  quote: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M3 20h18"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  bell: '<path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2h16z"/><path d="M10 21h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4"/><circle cx="12" cy="17" r=".6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  contacts: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  /* Canales y acciones (en lugar de emoji: una sola familia de línea, en gris) */
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  whatsapp: '<path d="M20 11.5a8 8 0 0 1-11.9 7L4 19.5l1.1-3.9A8 8 0 1 1 20 11.5z"/><path d="M9 8.5c0 3.5 2.5 6 6 6l.9-1.6-2-1-.9.9c-1-.4-2-1.4-2.4-2.4l.9-.9-1-2z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6"/>',
  messenger: '<path d="M12 3C7 3 3 6.7 3 11.3c0 2.6 1.3 4.9 3.3 6.4V21l3-1.7c.9.3 1.8.4 2.7.4 5 0 9-3.7 9-8.4S17 3 12 3z"/><path d="m7.5 13.5 3-3 2.5 2 3.5-3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
  test: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 15h9"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8z" transform="translate(-2 -2)"/><path d="m3 21 6-6"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  hash: '<path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 16.8v.01"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  paperclip: '<path d="m20 11.5-8.3 8.3a5 5 0 0 1-7-7L13 4.5a3.4 3.4 0 0 1 4.8 4.8L9.6 17.5a1.8 1.8 0 0 1-2.6-2.6l7.6-7.6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  heart: '<path d="M12 20s-7.5-4.6-9-9.2A4.6 4.6 0 0 1 12 7.5a4.6 4.6 0 0 1 9 3.3C19.5 15.4 12 20 12 20z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  'map-pin': '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  facebook: '<path d="M14.5 8H17V4.2h-2.8A4.2 4.2 0 0 0 10 8.4V11H7v3.8h3V21h4v-6.2h3l.7-3.8H14V8.9c0-.5.4-.9.9-.9z"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10.5V17M8 7.2v.01M12 17v-6.5M12 13.5a2.8 2.8 0 0 1 5.6 0V17"/>',
  youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="m10 9.3 5 2.7-5 2.7z"/>',
  tiktok: '<path d="M14 3v11.3A3.7 3.7 0 1 1 10.3 10.6"/><path d="M14 3c.6 2.6 2.4 4.4 5 4.8"/>',
  reddit: '<ellipse cx="12" cy="14.5" rx="8" ry="5.5"/><path d="M9.2 13.8v.01M14.8 13.8v.01M9.6 16.6c1.5.8 3.3.8 4.8 0M12 9l1.6-5 4.4 1.2"/><circle cx="19" cy="5.5" r="1.5"/>',
  bluesky: '<path d="M12 11.2C10.4 8 6.8 5 4.6 5 3 5 3.2 7.6 3.6 9.6 4.1 12 6.4 12.8 9 12.4c-2.7.7-3.6 2.6-1.9 4.4 2 2 3.8.2 4.9-2.8 1.1 3 2.9 4.8 4.9 2.8 1.7-1.8.8-3.7-1.9-4.4 2.6.4 4.9-.4 5.4-2.8.4-2 .6-4.6-1-4.6-2.2 0-5.8 3-7.4 6.2z"/>',
  threads: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12A8.8 8.8 0 1 0 17.4 19"/>',
  pinterest: '<circle cx="12" cy="12" r="9"/><path d="M10.6 8.6c3-1.2 5.8.4 5.3 3.4-.4 2.5-2.7 3.4-4.2 2.6M11.6 10.4 9.2 20.6"/>',
  'x-logo': '<path d="M4.5 4h4L19.5 20h-4zM19.5 4l-6.6 7.2M4.5 20l6.6-7.2"/>',
  /* Lienzo de flujos */
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  note: '<path d="M5 4h14a1 1 0 0 1 1 1v9l-6 6H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 20v-5a1 1 0 0 1 1-1h5"/>',
  type: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  tag: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11.5 6.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  layout: '<rect x="4" y="3" width="7" height="6" rx="1"/><rect x="13" y="15" width="7" height="6" rx="1"/><path d="M7.5 9v4.5a1.5 1.5 0 0 0 1.5 1.5h4"/>',
  wand: '<path d="M4 20 14.5 9.5"/><path d="m13 7 2 2"/><path d="M17.5 3.5v3M16 5h3M19.5 10.5v2M18.5 11.5h2M10.5 3v2M9.5 4h2"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 14v4.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
};

/** Ícono de línea decorativo (el texto de al lado dice qué es). */
export function icon(name, size = 18) {
  return h('span', {
    class: 'icon', 'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? ''}</svg>`,
  });
}

/** Cada red social con su ícono de línea; las que no tienen uno propio, un enlace. */
const NETWORK_ICONS = { instagram: 'instagram', facebook: 'facebook', messenger: 'messenger', whatsapp: 'whatsapp', telegram: 'send', twitter: 'x-logo', bluesky: 'bluesky', reddit: 'reddit', linkedin: 'linkedin', tiktok: 'tiktok', youtube: 'youtube', threads: 'threads', pinterest: 'pinterest', googlebusiness: 'map-pin' };
export const networkIcon = (platform, size = 18) => icon(NETWORK_ICONS[platform] || 'link', size);

/** Bien o mal, como marca de línea con su color (el texto de al lado dice qué). */
export const okMark = (ok, size = 14) => h('span', { class: `ok-mark ${ok ? 'yes' : 'no'}` }, icon(ok ? 'check' : 'x', size));
