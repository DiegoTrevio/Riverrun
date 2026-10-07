/** Marca blanca: qué nombre, logo y color ve cada cliente. */
import type { FastifyRequest } from 'fastify';
import { config } from './config.js';
import { query, queryOne } from './db.js';

export interface Brand {
  id: string;
  name: string;
  color: string;
  domain: string | null;
  support_email: string;
  logo_type: string;
  logo_version: number;
}
const COLS = 'id, name, color, domain, support_email, logo_type, logo_version';

export const DEFAULT_BRAND = { name: 'Panel de Chatbots', color: '', logo: null as string | null, support_email: '', brand_id: null as string | null };

/** El dominio con el que entró el visitante, sin puerto y en minúsculas. */
export function hostOf(req: FastifyRequest): string {
  return String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
}

export const brandByDomain = (host: string) => (host ? queryOne<Brand>(`SELECT ${COLS} FROM brands WHERE domain = $1`, [host]) : Promise.resolve(null));
export const brandById = (id: string | null | undefined) => (id ? queryOne<Brand>(`SELECT ${COLS} FROM brands WHERE id = $1`, [id]) : Promise.resolve(null));
export const brandOfAccount = (accountId: string) => queryOne<Brand>(`SELECT ${COLS.split(', ').map((c) => `b.${c}`).join(', ')} FROM brands b JOIN accounts a ON a.brand_id = b.id WHERE a.id = $1`, [accountId]);
export const listBrands = () => query<Brand & { accounts: number }>(`SELECT ${COLS.split(', ').map((c) => `b.${c}`).join(', ')}, (SELECT count(*)::int FROM accounts a WHERE a.brand_id = b.id) AS accounts FROM brands b ORDER BY b.created_at`);

export function publicBrand(b: Brand | null) {
  if (!b) return { ...DEFAULT_BRAND };
  return { name: b.name, color: b.color, logo: b.logo_type ? `/brand/${b.id}/logo?v=${b.logo_version}` : null, support_email: b.support_email, brand_id: b.id };
}

/** Remitente y dirección base para los correos de una cuenta: los de su marca si tiene dominio propio. */
export async function mailBrand(accountId: string | null | undefined): Promise<{ fromName?: string; base: string }> {
  const b = accountId ? await brandOfAccount(accountId) : null;
  return { fromName: b?.name, base: b?.domain ? `https://${b.domain}` : config.publicBaseUrl };
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
export function parseLogo(dataUrl: string): { type: string; bytes: Buffer } | null {
  const m = DATA_URL.exec(dataUrl);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  return bytes.length > 0 && bytes.length <= 256 * 1024 ? { type: m[1], bytes } : null;
}
