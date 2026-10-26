import { cleanAlertPrefs } from '../automation/alert-groups.js';
import type { AlertPrefs } from '../types.js';
import { aiBudgetRoutes } from './ai-budget.js';
import { NETWORKS, ZERNIO_SECRET, zernioEnabled, zernioKey, zernioKeySource } from '../channels/zernio.js';
import { knowledgeMonitorReport } from '../engine/knowledge-monitor.js';
import { operationalStatus } from '../engine/operations.js';
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
  currentSession,
} from '../auth.js';
import { adapterFor } from '../channels/index.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { logEvent } from '../logs.js';
import type { ChatService } from '../service.js';
import * as store from '../store/index.js';
import { AiSettingsSchema, CHANNEL_TYPES, FlowSchema, KNOWLEDGE_CATEGORIES, PersonalitySchema, RulesSchema, type Role } from '../types.js';
import { BUSINESS_TYPES } from '../templates/business.js';
import { wizardDefaults } from '../templates/agent-builder.js';
import { systemStatus } from '../monitor.js';
import { listIncidents } from '../observability/incidents.js';
import { diagnosticsReport, refreshDiagnostics } from '../diagnostics.js';
import { assertWithinLimit, LimitsSchema } from '../billing/limits.js';
import { billingEnabled, paymentDue } from '../billing/service.js';
import { deleteAccountFully } from '../accounts/delete.js';
import { deletionDate } from '../accounts/retention.js';
import { parse } from './util.js';
import { metaConnectEnabled } from '../channels/meta-connect.js';
import { verifyZernioKey, workspaceChange, zernioSystemStatus } from '../channels/zernio-connect.js';
import { removePlatformSecret, savePlatformSecret } from '../platform-secrets.js';

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
    await setSessionCookie(reply, user.id, user.password_hash, 'password');
    const { password_hash, ...safe } = user;
    void password_hash;
    return { ok: true, user: safe };
  });

  app.post('/api/logout', async (req, reply) => {
    // Cerrar sesión la invalida en el servidor: la cookie copiada a otro lado ya no sirve.
    const s = currentSession(req);
    if (s?.sid && /^[0-9a-f-]{36}$/i.test(s.sid)) await store.revokeUserSessions(s.uid, { only: s.sid });
    clearSessionCookie(reply);
    return { ok: true };
  });
}

/** Rutas autenticadas: perfil, cuentas, usuarios, estadísticas y registros. */
export async function adminRoutes(api: FastifyInstance, service: ChatService) {
  await aiBudgetRoutes(api);
  api.get('/api/me', async (req) => {
    const account = req.user.account_id ? await store.getAccount(req.user.account_id) : null;
    // Pago pendiente: los administradores ven la franja «Actualiza tu pago» en todo el panel.
    const due = account && req.user.role !== 'agent' ? await paymentDue(account.id) : null;
    return { user: req.user, account: account && { ...account, payment_due: due, deletion_date: deletionDate(account) } };
  });

  api.put('/api/me', async (req) => {
    const b = parse(z.object({ name: z.string().trim().max(120).optional(), phone: z.string().max(30).optional(), notify_whatsapp: z.boolean().optional(), available: z.boolean().optional(), alert_prefs: z.record(z.string(), z.unknown()).optional() }), req.body);
    return store.updateUser(req.user.id, { ...b, alert_prefs: b.alert_prefs ? cleanAlertPrefs(b.alert_prefs) : undefined });
  });

  /* ------------------------------ Mis sesiones ------------------------------ */
  // Cada persona ve y cierra solo las suyas.
  const browserOf = (ua: string) => {
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
    const os = /iPhone|iPad/.test(ua) ? 'iPhone o iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${b} en ${os}` : b;
  };
  // Solo una parte de la IP: suficiente para reconocerla, sin mostrarla completa.
  const partialIp = (ip: string) => (ip.includes(':') ? `${ip.split(':').slice(0, 3).join(':')}:…` : ip.split('.').slice(0, 2).join('.') + (ip.includes('.') ? '.…' : ''));
  api.get('/api/me/sessions', async (req: any) => ({
    // Una sesión de antes de registrar sesiones no aparece en la lista (vence sola en máximo 7 días).
    legacy: !req.sessionId,
    sessions: (await store.listUserSessions(req.user.id)).map((s) => ({
      id: s.id, device: browserOf(s.user_agent), ip: partialIp(s.ip), via: s.via, created_at: s.created_at, last_seen_at: s.last_seen_at, current: s.id === req.sessionId,
    })),
  }));
  api.delete('/api/me/sessions/:id', async (req: any) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !(await store.revokeUserSessions(req.user.id, { only: req.params.id }))) throw notFound('Sesión no encontrada');
    await logEvent({ level: 'info', source: 'admin', message: `Sesión cerrada desde Mi perfil por ${req.user.email}`, accountId: req.user.account_id ?? undefined });
    return { ok: true, current: req.params.id === req.sessionId };
  });
  api.post('/api/me/sessions/revoke-others', async (req: any) => {
    const closed = await store.revokeUserSessions(req.user.id, { except: req.sessionId });
    await logEvent({ level: 'info', source: 'admin', message: `${req.user.email} cerró sus otras ${closed} sesiones`, accountId: req.user.account_id ?? undefined });
    return { ok: true, closed };
  });

  api.put('/api/me/password', async (req, reply) => {
    const b = parse(z.object({ current: z.string(), password: Password }), req.body);
    const full = await store.getUserForLogin(req.user.email);
    if (!full || !(await verifyPassword(b.current, full.password_hash))) throw new HttpError(400, 'La contraseña actual no es correcta');
    const hash = await hashPassword(b.password);
    await store.updateUser(req.user.id, { password_hash: hash });
    // Las demás sesiones se cierran; esta sigue abierta con la nueva huella.
    await store.revokeUserSessions(req.user.id);
    await setSessionCookie(reply, req.user.id, hash, 'password_change');
    return { ok: true };
  });

  api.get('/api/meta', async () => ({
    knowledge_categories: KNOWLEDGE_CATEGORIES,
    max_whatsapp_profiles: store.MAX_WHATSAPP_PROFILES,
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
    support_contact: config.signup.supportContact,
    // Con lo que el asistente de creación propone para cada tipo (trabajo, datos que pide y trato).
    business_types: BUSINESS_TYPES.map(({ key, label }) => ({ key, label, defaults: wizardDefaults(key) })),
    require_email: config.signup.requireEmail,
    billing_enabled: await billingEnabled(),
    zernio_enabled: zernioEnabled(),
    receivables_enabled: config.receivables.enabled,
    meta_connect_enabled: metaConnectEnabled(),
    // Redes para una conexión de mensajes; y lo que permite cada red de Zernio (comentarios, posts, estadísticas…).
    social_networks: NETWORKS.filter((n) => n.dm).map(({ id, label, flow }) => ({ id, label, flow })),
    social_capabilities: NETWORKS.map(({ id, label, flow, dm, comments, reviews, posts, analytics, privateReply, interactive, window24h }) => ({ id, label, flow, dm, comments, reviews, posts, analytics, privateReply, interactive, window24h })),
    version: config.monitor.version,
  }));

  api.get('/api/system/status', { preHandler: requireRole('superadmin') }, async () => systemStatus());
  // Historial de incidencias, de la más reciente a la más antigua. Sin contenido de mensajes.
  /* Llave de Zernio de la plataforma: una sola para todas las cuentas. */
  const superadmin = { preHandler: requireRole('superadmin') };
  const envOwned = () => new HttpError(409, 'La llave está definida en el servidor (ZERNIO_API_KEY en el .env). Para administrarla desde aquí, quítala de allí y reinicia.');
  api.get('/api/system/zernio', superadmin, async () => zernioSystemStatus(false));
  api.post('/api/system/zernio/check', superadmin, async () => {
    if (!zernioEnabled()) throw new HttpError(400, 'Primero guarda la llave de Zernio.');
    const v = await verifyZernioKey(zernioKey());
    if (!v.ok) throw new HttpError(400, v.error);
    return zernioSystemStatus(true);
  });
  api.put('/api/system/zernio', superadmin, async (req: any) => {
    if (zernioKeySource() === 'env') throw envOwned();
    const { api_key, confirm_workspace_change } = parse(z.object({ api_key: z.string().trim().min(8, 'Pega la llave completa').max(500), confirm_workspace_change: z.boolean().optional() }), req.body);
    const v = await verifyZernioKey(api_key);
    if (!v.ok) throw new HttpError(400, v.error);
    // Una llave de OTRA cuenta de Zernio: los perfiles y redes de los negocios no existen allá (hay que reconectarlas).
    const ws = await workspaceChange(api_key, false);
    if (ws.changed && ws.affected && !confirm_workspace_change) {
      throw new HttpError(409, `Esta llave es de otra cuenta de Zernio. Los ${ws.affected} negocios con redes conectadas tendrán que volver a conectarlas. Confírmalo para continuar.`, ['confirm_workspace_change']);
    }
    await workspaceChange(api_key, true);
    await savePlatformSecret(ZERNIO_SECRET, api_key, req.user.id);
    await logEvent({ level: 'info', source: 'admin', message: `Llave de Zernio guardada desde el panel por ${req.user.email} (termina en ${api_key.slice(-4)})` });
    return zernioSystemStatus(true);
  });
  api.delete('/api/system/zernio', superadmin, async (req: any) => {
    if (zernioKeySource() === 'env') throw envOwned();
    await removePlatformSecret(ZERNIO_SECRET);
    await logEvent({ level: 'warn', source: 'admin', message: `Llave de Zernio quitada desde el panel por ${req.user.email}: las redes sociales dejan de funcionar` });
    return zernioSystemStatus(false);
  });

  api.get('/api/system/incidents', { preHandler: requireRole('superadmin') }, async (req: any) => listIncidents(Number(req.query?.limit) || 50));
  // Configuración y servicios externos por niveles (configurado → accesible → credenciales → funcional → listo). Sin secretos.
  api.get('/api/system/diagnostics', { preHandler: requireRole('superadmin') }, async () => diagnosticsReport());
  api.post('/api/system/diagnostics/run', { preHandler: requireRole('superadmin') }, async () => {
    await refreshDiagnostics();
    return diagnosticsReport();
  });

  /* ------------------------------ Cuentas ------------------------------ */
  api.get('/api/accounts', async (req) => {
    const all = req.user.role === 'superadmin';
    if ((req.query as { view?: string }).view === 'selector') {
      return query('SELECT id, name, active, business_type FROM accounts ' + (all ? '' : 'WHERE id = $1 ') + 'ORDER BY created_at DESC', all ? [] : [req.user.account_id]);
    }
    const rows = await query(
      `SELECT a.*,
         (SELECT count(*)::int FROM chatbots b WHERE b.account_id = a.id) AS chatbots,
         (SELECT count(*)::int FROM channels c WHERE c.account_id = a.id AND c.type <> 'playground') AS channels,
         (SELECT count(*)::int FROM users u WHERE u.account_id = a.id) AS users,
         (SELECT count(*)::int FROM conversations cv JOIN channels c ON c.id = cv.channel_id WHERE cv.account_id = a.id AND c.type <> 'playground') AS conversations,
         (SELECT count(*)::int FROM conversations cv JOIN channels c ON c.id = cv.channel_id
            WHERE cv.account_id = a.id AND c.type <> 'playground' AND cv.last_message_at >= date_trunc('month', now())) AS conversations_month,
         (SELECT coalesce(sum(r.cost_usd), 0)::float FROM ai_runs r WHERE r.account_id = a.id AND r.created_at >= date_trunc('month', now())) AS ai_cost_month,
         (SELECT max(cv.last_message_at) FROM conversations cv WHERE cv.account_id = a.id) AS last_activity_at,
         (SELECT u.email FROM users u WHERE u.id = a.owner_user_id) AS owner_email,
         (SELECT u.email_verified_at IS NOT NULL FROM users u WHERE u.id = a.owner_user_id) AS owner_verified,
         (SELECT c.connection_state FROM channels c WHERE c.account_id = a.id AND c.type = 'whatsapp' ORDER BY c.created_at LIMIT 1) AS whatsapp_state
       FROM accounts a ${all ? '' : 'WHERE a.id = $1'} ORDER BY a.created_at DESC`,
      all ? [] : [req.user.account_id],
    );
    // El agente ve su cuenta sin los totales ni los datos del dueño: son de la cuenta entera.
    // Cuándo se borraría una cuenta en pausa (retención automática), para el superadmin.
    if (all) for (const r of rows as any[]) r.deletion_date = deletionDate(r);
    if (req.user.role !== 'agent') return rows;
    const hidden = ['users', 'conversations', 'conversations_month', 'ai_cost_month', 'last_activity_at', 'owner_email', 'owner_verified'];
    return rows.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !hidden.includes(k))));
  });

  /* ------------------------------ Consumo de IA ------------------------------ */

  /**
   * Gasto de IA. Sin cuenta (superadmin): total del mes por cuenta. Con cuenta: por día y por tipo.
   * `month` = AAAA-MM (por defecto, el actual).
   */
  api.get('/api/usage', { preHandler: requireRole('admin') }, async (req: any) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    const from = `${month}-01T00:00:00Z`;
    const range = `created_at >= $1::timestamptz AND created_at < $1::timestamptz + interval '1 month'`;
    const accountId = scopeAccount(req.user, req.query.account_id);
    if (!accountId) {
      const accounts = await query(
        `SELECT a.id, a.name, a.status, coalesce(sum(r.cost_usd), 0)::float AS cost_usd, count(r.id)::int AS calls,
           (SELECT count(*)::int FROM ai_spend s WHERE s.account_id=a.id AND s.created_at >= $1::timestamptz AND s.created_at < $1::timestamptz + interval '1 month' AND s.charged_usd IS NULL AND (s.reserved_usd IS NULL OR s.quote->>'model_mismatch'='true') AND s.state<>'rejected') AS unknown_costs,
           coalesce(sum(r.input_tokens), 0)::bigint AS input_tokens, coalesce(sum(r.output_tokens), 0)::bigint AS output_tokens,
           coalesce(sum(r.audio_seconds), 0)::int AS audio_seconds
         FROM accounts a LEFT JOIN ai_runs r ON r.account_id = a.id AND r.created_at >= $1::timestamptz AND r.created_at < $1::timestamptz + interval '1 month'
         GROUP BY a.id ORDER BY cost_usd DESC, a.name`,
        [from],
      );
      const total = accounts.reduce((t: number, a: any) => t + a.cost_usd, 0);
      return { month, total_usd: total, accounts };
    }
    const [days, kinds, models] = await Promise.all([
      query(`SELECT to_char(created_at, 'YYYY-MM-DD') AS day, sum(cost_usd)::float AS cost_usd, count(*)::int AS calls FROM ai_runs WHERE account_id = $2 AND ${range} GROUP BY 1 ORDER BY 1`, [from, accountId]),
      query(`SELECT kind, sum(cost_usd)::float AS cost_usd, count(*)::int AS calls FROM ai_runs WHERE account_id = $2 AND ${range} GROUP BY 1 ORDER BY 2 DESC`, [from, accountId]),
      query(
        `SELECT model, sum(cost_usd)::float AS cost_usd, sum(input_tokens)::bigint AS input_tokens, sum(cached_tokens)::bigint AS cached_tokens,
           sum(output_tokens)::bigint AS output_tokens, sum(audio_seconds)::int AS audio_seconds, count(*)::int AS calls
         FROM ai_runs WHERE account_id = $2 AND ${range} GROUP BY 1 ORDER BY 2 DESC`,
        [from, accountId],
      ),
    ]);
    const conversations = (await queryOne<{ n: number }>(
      `SELECT count(DISTINCT conversation_id)::int AS n FROM ai_runs WHERE account_id = $2 AND conversation_id IS NOT NULL AND ${range}`,
      [from, accountId],
    ))!.n;
    const total = kinds.reduce((t: number, k: any) => t + k.cost_usd, 0);
    const costBreakdown=await queryOne(`SELECT count(*) FILTER(WHERE charged_usd IS NULL AND (reserved_usd IS NULL OR quote->>'model_mismatch'='true') AND state<>'rejected')::int AS unknown_costs,coalesce(sum(charged_usd) FILTER(WHERE cost_source='reported'),0) AS reported_usd,coalesce(sum(charged_usd) FILTER(WHERE cost_source IN ('estimated','legacy','confirmed')),0) AS estimated_usd FROM ai_spend WHERE account_id=$2 AND ${range}`,[from,accountId]);
    return { month, account_id: accountId, cost_breakdown:costBreakdown, total_usd: total, conversations, cost_per_conversation: conversations ? total / conversations : 0, days, kinds, models };
  });

  /** Precios por modelo para estimar el costo cuando el proveedor no lo reporta (solo superadmin). */
  api.get('/api/ai-prices', { preHandler: requireRole('superadmin') }, async () => query(`SELECT * FROM ai_prices ORDER BY model`));

  api.put('/api/ai-prices/:model', { preHandler: requireRole('superadmin') }, async (req: any) => {
    const n = z.number().min(0).max(10000);
    const b = parse(z.object({ input_per_mtok: n.default(0), cached_per_mtok: n.default(0), output_per_mtok: n.default(0), per_audio_minute: n.default(0),is_free:z.boolean().default(false) }), req.body);
    const model = z.string().trim().min(1).max(100).parse(req.params.model);
    return queryOne(
      `INSERT INTO ai_prices (model, input_per_mtok, cached_per_mtok, output_per_mtok, per_audio_minute,is_free) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (model) DO UPDATE SET input_per_mtok = $2, cached_per_mtok = $3, output_per_mtok = $4, per_audio_minute = $5,is_free=$6, updated_at = now() RETURNING *`,
      [model, b.input_per_mtok, b.cached_per_mtok, b.output_per_mtok, b.per_audio_minute,b.is_free],
    );
  });

  api.delete('/api/ai-prices/:model', { preHandler: requireRole('superadmin') }, async (req: any) => {
    await query(`DELETE FROM ai_prices WHERE model = $1`, [req.params.model]);
    return { ok: true };
  });

  const AccountBody = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
    status: z.enum(['trial', 'active', 'paused']).optional(),
    plan: z.string().trim().max(60).optional(),
    trial_ends_at: z.string().datetime({ offset: true }).nullable().optional(),
    /** Atajo: extender la prueba N días desde hoy (o desde su vencimiento, si aún no vence). */
    extend_trial_days: z.number().int().min(1).max(365).optional(),
    /** Excepción de límites para esta cuenta (solo las claves indicadas; {} = quitar la excepción). */
    limits_override: LimitsSchema.optional(),
    brand_id: z.string().uuid().nullable().optional(),
    /** Conservar la cuenta aunque siga en pausa (no la borra la retención automática). */
    keep_data: z.boolean().optional(),
  });

  api.post('/api/accounts', { preHandler: requireRole('superadmin') }, async (req) => {
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        admin: z.object({ name: z.string().trim().max(120).default(''), email: Email, password: Password }).optional(),
      }),
      req.body,
    );
    const passwordHash = b.admin ? await hashPassword(b.admin.password) : null;
    const { account, admin } = await withTransaction(async (client) => {
      const account = await store.createAccount(b.name, {}, client);
      const admin = b.admin ? await store.createUser({ account_id: account.id, role: 'admin', name: b.admin.name, email: b.admin.email, password_hash: passwordHash! }, client) : null;
      if (admin) {
        await client.query('UPDATE accounts SET owner_user_id = $1 WHERE id = $2', [admin.id, account.id]);
        account.owner_user_id = admin.id;
      }
      return { account, admin };
    });
    await logEvent({ level: 'info', source: 'admin', message: `Cuenta creada: ${account.name}`, accountId: account.id });
    return { ...account, admin };
  });

  api.put('/api/accounts/:id', { preHandler: requireRole('superadmin') }, async (req: any) => {
    const b = parse(AccountBody, req.body);
    const before = await store.getAccount(req.params.id);
    if (!before) throw notFound('Cuenta no encontrada');
    // Un plan mal escrito dejaría a la cuenta con límites distintos a los que se vendieron: solo se aceptan planes existentes.
    if (b.plan && !(await queryOne(`SELECT 1 FROM plans WHERE key = $1`, [b.plan]))) throw new HttpError(400, `El plan "${b.plan}" no existe`);
    let trialEnds: Date | null | undefined = b.trial_ends_at === undefined ? undefined : b.trial_ends_at ? new Date(b.trial_ends_at) : null;
    let status = b.status;
    if (b.extend_trial_days) {
      const base = Math.max(Date.now(), before.trial_ends_at ? new Date(before.trial_ends_at).getTime() : 0);
      trialEnds = new Date(base + b.extend_trial_days * 86400_000);
      status = status ?? 'trial';
    }
    const acc = (await store.updateAccount(before.id, { name: b.name, active: b.active, status, plan: b.plan, trial_ends_at: trialEnds, limits_override: b.limits_override ? (Object.fromEntries(Object.entries(b.limits_override).filter(([, v]) => v)) as Record<string, number>) : undefined, brand_id: b.brand_id, keep_data: b.keep_data }))!;
    const changes = [b.active === false ? 'desactivada' : '', status && status !== before.status ? `estado: ${status}` : '', trialEnds !== undefined ? `prueba hasta ${trialEnds?.toISOString().slice(0, 10) ?? '—'}` : '',
      b.keep_data !== undefined && b.keep_data !== before.keep_data ? (b.keep_data ? 'se conservan sus datos' : 'retención normal') : '']
      .filter(Boolean)
      .join(', ');
    await logEvent({ level: 'info', source: 'admin', message: `Cuenta actualizada: ${acc.name}${changes ? ` (${changes})` : ''}`, accountId: acc.id });
    return acc;
  });

  api.delete('/api/accounts/:id', { preHandler: requireRole('superadmin') }, async (req: any) => {
    const acc = await store.getAccount(req.params.id);
    if (!acc) throw notFound('Cuenta no encontrada');
    await deleteAccountFully(acc);
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
        phone: z.string().max(30).default(''),
        notify_whatsapp: z.boolean().default(false),
      }),
      req.body,
    );
    if (b.role === 'superadmin') {
      if (req.user.role !== 'superadmin') throw new HttpError(403, 'Solo un superadministrador puede crear otro');
      return store.createUser({ account_id: null, role: 'superadmin', name: b.name, email: b.email, password_hash: await hashPassword(b.password) });
    }
    const accountId = await targetAccount(req.user, b.account_id);
    await assertWithinLimit(accountId, 'users');
    const created = await store.createUser({ account_id: accountId, role: b.role, name: b.name, email: b.email, password_hash: await hashPassword(b.password) });
    const user = b.phone || b.notify_whatsapp ? ((await store.updateUser(created.id, { phone: b.phone, notify_whatsapp: b.notify_whatsapp })) ?? created) : created;
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
        role: z.enum(['superadmin', 'admin', 'agent']).optional(),
        account_id: z.string().uuid().nullable().optional(),
        active: z.boolean().optional(),
        password: Password.optional(),
        phone: z.string().max(30).optional(),
        notify_whatsapp: z.boolean().optional(),
        available: z.boolean().optional(),
        alert_prefs: z.record(z.string(), z.unknown()).optional(),
      }),
      req.body,
    );
    if (req.user.role !== 'superadmin' && (b.account_id !== undefined || b.role === 'superadmin')) {
      throw new HttpError(403, 'Solo el maestro puede asignar perfiles o acceso global');
    }
    let accountId = target.account_id;
    if (b.account_id !== undefined) accountId = b.account_id;
    if (b.role === 'superadmin') accountId = null;
    const nextRole = b.role ?? target.role;
    if (nextRole === 'superadmin' && accountId !== null) throw new HttpError(400, 'El maestro tiene acceso global y no se limita a un perfil');
    if (nextRole !== 'superadmin') {
      if (!accountId) throw new HttpError(400, 'Asigna un perfil a este usuario');
      if (!(await store.getAccount(accountId))) throw notFound('Perfil no encontrado');
    }
    if (target.id === req.user.id && (b.active === false || (b.role && b.role !== req.user.role))) {
      throw new HttpError(400, 'No puedes desactivarte ni cambiar tu propio rol');
    }
    if (target.role === 'superadmin' && b.role && b.role !== 'superadmin') throw new HttpError(400, 'El rol de superadministrador no se cambia');
    if (target.role === 'superadmin' && b.active === false && (await store.countSuperadmins()) <= 1) {
      throw new HttpError(400, 'Debe quedar al menos un superadministrador activo');
    }
    if (b.active === true && !target.active && target.account_id) await assertWithinLimit(target.account_id, 'users');
    const patch: { name?: string; email?: string; role?: Role; account_id?: string | null; active?: boolean; password_hash?: string; phone?: string; notify_whatsapp?: boolean; available?: boolean; alert_prefs?: AlertPrefs } = {
      name: b.name,
      email: b.email,
      role: b.role,
      account_id: accountId !== target.account_id ? accountId : undefined,
      active: b.active,
      phone: b.phone,
      notify_whatsapp: b.notify_whatsapp,
      available: b.available,
      alert_prefs: b.alert_prefs ? cleanAlertPrefs(b.alert_prefs) : undefined,
    };
    if (b.password) patch.password_hash = await hashPassword(b.password);
    const updated = await store.updateUser(target.id, patch, req.user.role === 'superadmin' ? undefined : scopeAccount(req.user)!);
    if (!updated) throw notFound('Usuario no encontrado');
    // Desactivar a alguien, cambiarle el correo o la contraseña cierra todas sus sesiones abiertas. Un cambio de rol o de
    // cuenta aplica al momento en las sesiones abiertas (el usuario se vuelve a leer en cada petición).
    if (!updated.active || updated.email !== target.email || patch.password_hash) await store.revokeUserSessions(updated.id);
    if (updated.role !== target.role || updated.account_id !== target.account_id) {
      await logEvent({ level: 'info', source: 'admin', message: `Permisos de usuario actualizados: ${updated.email}`, accountId: updated.account_id ?? target.account_id ?? undefined,
        details: { actor_id: req.user.id, user_id: updated.id, previous_role: target.role, role: updated.role, previous_account_id: target.account_id, account_id: updated.account_id } });
    }
    return updated;
  });

  api.delete('/api/users/:id', admins, async (req: any) => {
    const target = await manageable(req);
    if (target.id === req.user.id) throw new HttpError(400, 'No puedes eliminar tu propio usuario');
    if (target.role === 'superadmin' && (await store.countSuperadmins()) <= 1) throw new HttpError(400, 'Debe quedar al menos un superadministrador');
    const deleted = await store.deleteUser(target.id, req.user.role === 'superadmin' ? undefined : scopeAccount(req.user)!);
    if (!deleted) throw notFound('Usuario no encontrado');
    return { ok: true };
  });

  /* ------------------------------ Estadísticas ------------------------------ */
  api.get('/api/stats', { preHandler: requireRole('admin') }, async (req: any) => {
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

  api.get('/api/knowledge/monitor', { preHandler: requireRole('admin') }, async (req: any) => {
    const requested = req.user.role === 'superadmin' && req.query.account_id ? parse(z.string().uuid(),req.query.account_id) : undefined;
    return knowledgeMonitorReport(scopeAccount(req.user,requested));
  });

  api.get('/api/health/operations', { preHandler: requireRole('superadmin') }, async () => operationalStatus());

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
