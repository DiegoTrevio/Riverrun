import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount, HttpError, notFound, requireRole, scopeAccount, targetAccount } from '../access.js';
import {
  clearSessionCookie,
  hashPassword,
  login,
  loginAllowed,
  registerLoginFailure,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';
import { adapterFor } from '../channels/index.js';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { imageAbsolutePath } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import { AiSettingsSchema, CHANNEL_TYPES, FlowSchema, KNOWLEDGE_CATEGORIES, PersonalitySchema, RulesSchema, type Role } from '../types.js';
import { parse } from './util.js';

const Password = z.string().min(8, 'mínimo 8 caracteres').max(200);
const Email = z.string().trim().toLowerCase().email('correo inválido').max(200);

/** Rutas públicas de sesión. */
export async function sessionRoutes(app: FastifyInstance) {
  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { user?: string; email?: string; password?: string };
    if (!loginAllowed(req.ip)) return reply.code(429).send({ error: 'Demasiados intentos, espera 15 minutos' });
    const who = String(body.email ?? body.user ?? '');
    const user = await login(who, String(body.password ?? ''));
    if (!user) {
      registerLoginFailure(req.ip);
      await logEvent({ level: 'warn', source: 'admin', message: 'Intento de acceso fallido', details: { ip: req.ip, email: who.slice(0, 100) } });
      return reply.code(401).send({ error: 'Usuario o contraseña incorrectos' });
    }
    setSessionCookie(reply, user.id, user.password_hash);
    const { password_hash, ...safe } = user;
    void password_hash;
    return { ok: true, user: safe };
  });

  app.post('/api/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });
}

/** Rutas autenticadas: perfil, cuentas, usuarios, estadísticas y registros. */
export async function adminRoutes(api: FastifyInstance, service: ChatService) {
  api.get('/api/me', async (req) => ({
    user: req.user,
    account: req.user.account_id ? await store.getAccount(req.user.account_id) : null,
  }));

  api.put('/api/me/password', async (req, reply) => {
    const b = parse(z.object({ current: z.string(), password: Password }), req.body);
    const full = await store.getUserForLogin(req.user.email);
    if (!full || !(await verifyPassword(b.current, full.password_hash))) throw new HttpError(400, 'La contraseña actual no es correcta');
    const hash = await hashPassword(b.password);
    await store.updateUser(req.user.id, { password_hash: hash });
    // Las demás sesiones se cierran; esta sigue abierta con la nueva huella.
    setSessionCookie(reply, req.user.id, hash);
    return { ok: true };
  });

  api.get('/api/meta', async () => ({
    knowledge_categories: KNOWLEDGE_CATEGORIES,
    channel_types: CHANNEL_TYPES.map((t) => ({ type: t, label: adapterFor(t).label })),
    defaults: {
      personality: PersonalitySchema.parse({}),
      rules: RulesSchema.parse({}),
      flow: FlowSchema.parse({}),
      ai: AiSettingsSchema.parse({}),
    },
    default_model: config.openai.defaultModel,
    public_base_url: config.publicBaseUrl,
    public_https: config.publicBaseUrl.startsWith('https://'),
  }));

  /* ------------------------------ Cuentas ------------------------------ */
  api.get('/api/accounts', async (req) => {
    const all = req.user.role === 'superadmin';
    return query(
      `SELECT a.*,
         (SELECT count(*)::int FROM chatbots b WHERE b.account_id = a.id) AS chatbots,
         (SELECT count(*)::int FROM channels c WHERE c.account_id = a.id AND c.type <> 'playground') AS channels,
         (SELECT count(*)::int FROM users u WHERE u.account_id = a.id) AS users,
         (SELECT count(*)::int FROM conversations cv JOIN channels c ON c.id = cv.channel_id WHERE cv.account_id = a.id AND c.type <> 'playground') AS conversations
       FROM accounts a ${all ? '' : 'WHERE a.id = $1'} ORDER BY a.created_at`,
      all ? [] : [req.user.account_id],
    );
  });

  const AccountBody = z.object({ name: z.string().trim().min(1).max(120).optional(), active: z.boolean().optional() });

  api.post('/api/accounts', { preHandler: requireRole('superadmin') }, async (req) => {
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        admin: z.object({ name: z.string().trim().max(120).default(''), email: Email, password: Password }).optional(),
      }),
      req.body,
    );
    const account = await store.createAccount(b.name);
    let admin = null;
    if (b.admin) {
      admin = await store.createUser({ account_id: account.id, role: 'admin', name: b.admin.name, email: b.admin.email, password_hash: await hashPassword(b.admin.password) });
    }
    await logEvent({ level: 'info', source: 'admin', message: `Cuenta creada: ${account.name}`, accountId: account.id });
    return { ...account, admin };
  });

  api.put('/api/accounts/:id', { preHandler: requireRole('superadmin') }, async (req: any) => {
    const b = parse(AccountBody, req.body);
    const acc = await store.updateAccount(req.params.id, b);
    if (!acc) throw notFound('Cuenta no encontrada');
    await logEvent({ level: 'info', source: 'admin', message: `Cuenta actualizada: ${acc.name}${b.active === false ? ' (desactivada)' : ''}`, accountId: acc.id });
    return acc;
  });

  api.delete('/api/accounts/:id', { preHandler: requireRole('superadmin') }, async (req: any) => {
    const acc = await store.getAccount(req.params.id);
    if (!acc) throw notFound('Cuenta no encontrada');
    const images = await query<{ file_path: string }>(`SELECT i.file_path FROM images i JOIN chatbots b ON b.id = i.chatbot_id WHERE b.account_id = $1`, [acc.id]);
    await store.deleteAccount(acc.id);
    for (const i of images) await fsp.rm(imageAbsolutePath(i), { force: true });
    await logEvent({ level: 'warn', source: 'admin', message: `Cuenta eliminada: ${acc.name}` });
    return { ok: true };
  });

  /* ------------------------------ Usuarios ------------------------------ */
  const admins = { preHandler: requireRole('admin') };

  api.get('/api/users', admins, async (req: any) => store.listUsers(scopeAccount(req.user, req.query.account_id)));

  api.post('/api/users', admins, async (req) => {
    const b = parse(
      z.object({
        name: z.string().trim().max(120).default(''),
        email: Email,
        password: Password,
        role: z.enum(['superadmin', 'admin', 'agent']),
        account_id: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    if (b.role === 'superadmin') {
      if (req.user.role !== 'superadmin') throw new HttpError(403, 'Solo un superadministrador puede crear otro');
      return store.createUser({ account_id: null, role: 'superadmin', name: b.name, email: b.email, password_hash: await hashPassword(b.password) });
    }
    const accountId = await targetAccount(req.user, b.account_id);
    const user = await store.createUser({ account_id: accountId, role: b.role, name: b.name, email: b.email, password_hash: await hashPassword(b.password) });
    await logEvent({ level: 'info', source: 'admin', message: `Usuario creado: ${user.email} (${user.role})`, accountId });
    return user;
  });

  /** Usuario que el usuario actual puede administrar. */
  const manageable = async (req: any) => {
    const target = await store.getUser(req.params.id);
    if (!target || (target.role === 'superadmin' && req.user.role !== 'superadmin')) throw notFound('Usuario no encontrado');
    if (target.account_id) assertAccount(req.user, target, 'Usuario no encontrado');
    return target;
  };

  api.put('/api/users/:id', admins, async (req: any) => {
    const target = await manageable(req);
    const b = parse(
      z.object({
        name: z.string().trim().max(120).optional(),
        email: Email.optional(),
        role: z.enum(['admin', 'agent']).optional(),
        active: z.boolean().optional(),
        password: Password.optional(),
      }),
      req.body,
    );
    if (target.id === req.user.id && (b.active === false || (b.role && b.role !== req.user.role))) {
      throw new HttpError(400, 'No puedes desactivarte ni cambiar tu propio rol');
    }
    if (target.role === 'superadmin' && b.role) throw new HttpError(400, 'El rol de superadministrador no se cambia');
    if (target.role === 'superadmin' && b.active === false && (await store.countSuperadmins()) <= 1) {
      throw new HttpError(400, 'Debe quedar al menos un superadministrador activo');
    }
    const patch: { name?: string; email?: string; role?: Role; active?: boolean; password_hash?: string } = {
      name: b.name,
      email: b.email,
      role: b.role,
      active: b.active,
    };
    if (b.password) patch.password_hash = await hashPassword(b.password);
    return store.updateUser(target.id, patch);
  });

  api.delete('/api/users/:id', admins, async (req: any) => {
    const target = await manageable(req);
    if (target.id === req.user.id) throw new HttpError(400, 'No puedes eliminar tu propio usuario');
    if (target.role === 'superadmin' && (await store.countSuperadmins()) <= 1) throw new HttpError(400, 'Debe quedar al menos un superadministrador');
    await store.deleteUser(target.id);
    return { ok: true };
  });

  /* ------------------------------ Estadísticas ------------------------------ */
  api.get('/api/stats', async (req: any) => {
    const account = scopeAccount(req.user, req.query.account_id);
    const rows = await query(
      `SELECT b.id, b.name, b.active, b.account_id,
          (SELECT count(*)::int FROM channels c WHERE c.chatbot_id = b.id AND c.type <> 'playground') AS channels,
          (SELECT count(*)::int FROM conversations cv JOIN channels c ON c.id = cv.channel_id WHERE cv.chatbot_id = b.id AND c.type <> 'playground') AS conversations,
          (SELECT count(*)::int FROM conversations cv WHERE cv.chatbot_id = b.id AND cv.status = 'human') AS waiting_human,
          (SELECT count(*)::int FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.chatbot_id = b.id AND m.created_at > now() - interval '24 hours') AS messages_24h,
          (SELECT coalesce(sum(input_tokens),0)::int FROM ai_runs r WHERE r.chatbot_id = b.id AND r.created_at > now() - interval '30 days') AS input_tokens_30d,
          (SELECT coalesce(sum(cached_tokens),0)::int FROM ai_runs r WHERE r.chatbot_id = b.id AND r.created_at > now() - interval '30 days') AS cached_tokens_30d,
          (SELECT coalesce(sum(output_tokens),0)::int FROM ai_runs r WHERE r.chatbot_id = b.id AND r.created_at > now() - interval '30 days') AS output_tokens_30d,
          (SELECT count(*)::int FROM event_logs l WHERE l.chatbot_id = b.id AND l.level = 'error' AND l.created_at > now() - interval '24 hours') AS errors_24h
        FROM chatbots b ${account ? 'WHERE b.account_id = $1' : ''} ORDER BY b.created_at`,
      account ? [account] : [],
    );
    return { chatbots: rows };
  });

  /* ------------------------------ Registros ------------------------------ */
  const filtered = (req: any, table: string, keys: string[], limit: number) => {
    const q = req.query as Record<string, string | undefined>;
    const params: unknown[] = [];
    const where: string[] = [];
    const account = scopeAccount(req.user, q.account_id);
    if (account) {
      params.push(account);
      where.push(`account_id = $${params.length}`);
    }
    for (const k of keys) {
      if (q[k]) {
        params.push(q[k]);
        where.push(`${k} = $${params.length}`);
      }
    }
    params.push(limit);
    return query(`SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
  };

  api.get('/api/logs', admins, async (req: any) =>
    filtered(req, 'event_logs', ['chatbot_id', 'channel_id', 'level', 'source', 'conversation_id'], Math.min(Number(req.query.limit) || 200, 1000)),
  );

  api.get('/api/ai-runs', admins, async (req: any) => filtered(req, 'ai_runs', ['chatbot_id', 'conversation_id'], 100));

  api.get('/api/health/deep', { preHandler: requireRole('superadmin') }, async () => {
    const db = await queryOne('SELECT 1 AS ok').then(() => true).catch(() => false);
    return {
      db,
      openai_configured: !!config.openai.apiKey,
      evolution_configured: !!config.evolution.apiKey,
      public_base_url: config.publicBaseUrl,
      queue: service.queue.size,
    };
  });
}
