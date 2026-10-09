import { api, h } from './core.js';

/* ------------------------------ Marca blanca ------------------------------ */

export const brand = { name: 'Panel de Chatbots', color: '', logo: null, support_email: '' };
let loaded = '';

/** Aplica nombre, color y pestaña. El color se mezcla para los fondos suaves, así sirve en modo claro y oscuro. */
export function applyBrand(b) {
  Object.assign(brand, { name: 'Panel de Chatbots', color: '', logo: null, support_email: '' }, b);
  document.title = brand.name;
  const root = document.documentElement.style;
  if (/^#[0-9a-f]{6}$/i.test(brand.color)) {
    root.setProperty('--accent', brand.color);
    root.setProperty('--accent-soft', `color-mix(in srgb, ${brand.color} 14%, transparent)`);
  } else {
    root.removeProperty('--accent');
    root.removeProperty('--accent-soft');
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
