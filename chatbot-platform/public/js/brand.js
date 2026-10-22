import { api, h } from './core.js';

/* ------------------------------ Marca blanca ------------------------------ */

export const brand = { name: 'Panel de Chatbots', color: '', logo: null, support_email: '' };
let loaded = '';
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const luminance = (hex) => {
  const rgb = hex.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
dark.addEventListener('change', () => applyBrand(brand));

const LADDER = ['--accent', '--accent-soft', '--accent-track', '--accent-ink', '--brand-accent', '--accent-foreground'];

/**
 * Aplica nombre, color y pestaña. Con un color de marca se arma toda la escalera del estilo: el tono en las marcas
 * pequeñas y sus tintes (pálido, pista y tinta oscura) en las áreas, mezclados con la superficie para claro y oscuro.
 */
export function applyBrand(b) {
  Object.assign(brand, { name: 'Panel de Chatbots', color: '', logo: null, support_email: '' }, b);
  document.title = brand.name;
  const root = document.documentElement.style;
  if (/^#[0-9a-f]{6}$/i.test(brand.color)) {
    const l = luminance(brand.color);
    const surface = dark.matches ? '#161617' : '#ffffff';
    const surfaces = dark.matches ? ['#0e0e0f', '#161617'] : ['#f9fafb', '#ffffff'];
    const safe = surfaces.every((color) => ratio(l, luminance(color)) >= 4.8) ? brand.color : dark.matches ? '#5fb8c6' : '#0f6b7a';
    root.setProperty('--accent', safe);
    root.setProperty('--brand-accent', brand.color);
    root.setProperty('--accent-foreground', ratio(l, 0) >= ratio(l, 1) ? '#000000' : '#ffffff');
    root.setProperty('--accent-soft', `color-mix(in srgb, ${safe} ${dark.matches ? 16 : 8}%, ${surface})`);
    root.setProperty('--accent-track', `color-mix(in srgb, ${safe} ${dark.matches ? 32 : 22}%, ${surface})`);
    root.setProperty('--accent-ink', `color-mix(in srgb, ${safe} 62%, ${dark.matches ? '#ffffff' : '#000000'})`);
  } else {
    for (const name of LADDER) root.removeProperty(name);
  }
}

/** Marca del producto (sin logo de marca blanca): un globo de conversación con la onda de un río, en el tono de acento. */
export const productMark = () => h('span', { class: 'brand-mark', 'aria-hidden': 'true',
  html: '<svg viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="7" fill="currentColor"/>'
    + '<path d="M7.5 9.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H13l-4 3v-3H7.5A1.5 1.5 0 0 1 6 18v-7a1.5 1.5 0 0 1 1.5-1.5z" fill="#fff"/>'
    + '<path d="M9 14.6c1.2-1.1 2.3-1.1 3.4 0s2.3 1.1 3.4 0 2.2-1.1 3.2 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' });

/** 'host' = la marca del dominio (inicio de sesión y registro); 'mine' = la de la cuenta con sesión iniciada. */
export async function ensureBrand(kind) {
  if (loaded === kind) return;
  try {
    applyBrand(await api('GET', kind === 'mine' ? '/api/brand/mine' : '/api/brand'));
    loaded = kind;
  } catch { /* sin marca: se queda la de la plataforma */ }
}

export const resetBrand = () => { loaded = ''; };

export const brandMark = (size = 28) => (brand.logo ? h('img', { src: brand.logo, alt: brand.name, style: `height:${size}px;max-width:160px;object-fit:contain;vertical-align:middle` }) : null);
