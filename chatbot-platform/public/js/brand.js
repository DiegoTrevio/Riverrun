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

/** Aplica nombre, color y pestaña. El color se mezcla para los fondos suaves, así sirve en modo claro y oscuro. */
export function applyBrand(b) {
  Object.assign(brand, { name: 'Panel de Chatbots', color: '', logo: null, support_email: '' }, b);
  document.title = brand.name;
  const root = document.documentElement.style;
  if (/^#[0-9a-f]{6}$/i.test(brand.color)) {
    const l = luminance(brand.color);
    const surfaces = dark.matches ? ['#111418', '#1a1e24'] : ['#f5f6f8', '#ffffff'];
    const safe = surfaces.every((color) => ratio(l, luminance(color)) >= 4.8) ? brand.color : dark.matches ? '#25b39f' : '#08796d';
    root.setProperty('--accent', safe);
    root.setProperty('--brand-accent', brand.color);
    root.setProperty('--accent-foreground', ratio(l, 0) >= ratio(l, 1) ? '#000000' : '#ffffff');
    root.setProperty('--accent-soft', `color-mix(in srgb, ${safe} 10%, ${dark.matches ? '#1a1e24' : '#ffffff'})`);
  } else {
    root.removeProperty('--accent');
    root.removeProperty('--accent-soft');
    root.removeProperty('--brand-accent');
    root.removeProperty('--accent-foreground');
  }
}

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
