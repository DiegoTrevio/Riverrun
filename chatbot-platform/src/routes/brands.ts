/** Marca blanca: consulta pública por dominio, logo y administración (solo superadmin). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireRole } from '../access.js';
import { brandByDomain, brandOfAccount, hostOf, listBrands, parseLogo, publicBrand } from '../brands.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import { parse } from './util.js';

const Domain = z.string().trim().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Escribe un dominio como panel.miagencia.com (sin https://)');
const BrandBody = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre de la marca').max(60),
  color: z.string().trim().regex(/^(#[0-9a-fA-F]{6})?$/, 'El color debe ser como #1a73e8').default(''),
  domain: Domain.nullable().optional(),
  support_email: z.string().trim().email().or(z.literal('')).default(''),
  /** data:image/png|jpeg|webp;base64,… (máx. 256 KB). null = quitar el logo. */
  logo: z.string().nullable().optional(),
});

export async function brandPublicRoutes(app: FastifyInstance) {
  /** La marca del dominio por el que se entra (la usan el inicio de sesión y el registro). */
  app.get('/api/brand', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return publicBrand(await brandByDomain(hostOf(req)));
  });

  app.get('/brand/:id/logo', async (req: any, reply) => {
    const row = await queryOne<{ logo: Buffer | null; logo_type: string }>(`SELECT logo, logo_type FROM brands WHERE id = $1`, [String(req.params.id).replace(/[^0-9a-f-]/gi, '')]).catch(() => null);
    if (!row?.logo) return reply.code(404).send({ error: 'Sin logo' });
    return reply.header('content-type', row.logo_type).header('cache-control', 'public, max-age=86400').header('x-content-type-options', 'nosniff').send(row.logo);
  });

  /** Caddy pregunta aquí antes de pedir un certificado: solo para dominios registrados. */
  app.get('/internal/domain-ok', async (req: any, reply) => {
    const d = String(req.query.domain ?? '').toLowerCase();
    const main = (process.env.DOMAIN ?? '').toLowerCase();
    if (d && (d === main || (await brandByDomain(d)))) return { ok: true };
    return reply.code(404).send({ ok: false });
  });
}

export async function brandAdminRoutes(api: FastifyInstance) {
  const supers = { preHandler: requireRole('superadmin') };

  api.get('/api/brands', supers, async () => ({ brands: (await listBrands()).map((b) => ({ ...b, logo: publicBrand(b).logo })), cname_target: process.env.DOMAIN || new URL(config.publicBaseUrl).host }));

  const save = async (id: string | null, b: z.infer<typeof BrandBody>) => {
    const logo = b.logo ? parseLogo(b.logo) : null;
    if (b.logo && !logo) throw new HttpError(400, 'El logo debe ser PNG, JPG o WebP de máximo 256 KB');
    try {
      if (!id) {
        const row = await queryOne<{ id: string }>(
          `INSERT INTO brands (name, color, domain, support_email, logo, logo_type, logo_version) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [b.name, b.color, b.domain ?? null, b.support_email, logo?.bytes ?? null, logo?.type ?? '', logo ? 1 : 0],
        );
        return row!.id;
      }
      const r = await query(
        `UPDATE brands SET name = $2, color = $3, domain = $4, support_email = $5,
           logo = CASE WHEN $6::boolean THEN $7 ELSE logo END, logo_type = CASE WHEN $6::boolean THEN $8 ELSE logo_type END,
           logo_version = CASE WHEN $6::boolean THEN logo_version + 1 ELSE logo_version END WHERE id = $1 RETURNING id`,
        [id, b.name, b.color, b.domain ?? null, b.support_email, b.logo !== undefined, logo?.bytes ?? null, logo?.type ?? ''],
      );
      if (!r.length) throw new HttpError(404, 'Marca no encontrada');
      return id;
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'Ese dominio ya pertenece a otra marca');
      throw e;
    }
  };

  api.post('/api/brands', supers, async (req: any) => {
    const b = parse(BrandBody, req.body);
    const id = await save(null, b);
    await logEvent({ level: 'info', source: 'admin', message: `Marca creada: ${b.name}${b.domain ? ` (${b.domain})` : ''}` });
    return { id };
  });

  api.put('/api/brands/:id', supers, async (req: any) => {
    const b = parse(BrandBody, req.body);
    await save(req.params.id, b);
    return { ok: true };
  });

  api.delete('/api/brands/:id', supers, async (req: any) => {
    await query(`DELETE FROM brands WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  /** Marca de la cuenta con la que se entró (para el panel). */
  api.get('/api/brand/mine', async (req: any) => publicBrand(req.user.account_id ? await brandOfAccount(req.user.account_id) : null));
}
