import path from 'node:path';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function rolloutAccounts(value: string): string[] {
  if (!value.trim()) return [];
  const ids = [...new Set(value.split(',').map(id => id.trim().toLowerCase()))];
  if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) throw new Error('KNOWLEDGE_SEARCH_ACCOUNT_IDS debe contener UUID separados por comas.');
  return ids;
}

function monitorLimit(name: string, fallback: number, max: number) {
  const value = Number(env(name,String(fallback)));
  if (!Number.isFinite(value) || value < 0 || value > max) throw new Error('Umbral de supervisión inválido: '+name);
  return value;
}

const aiBaseUrl = env('OPENROUTER_BASE_URL', env('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const useOpenRouter = new URL(aiBaseUrl).hostname === 'openrouter.ai';

export const config = {
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://chatbot:chatbot@localhost:5432/chatbot'),
  /** URL con la que Evolution API puede llegar a este backend (p.ej. http://backend:3000 en docker). */
  webhookBaseUrl: env('WEBHOOK_BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
  /**
   * URL pública (HTTPS) del backend: la usan Telegram, Meta (Messenger/Instagram),
   * el chat web y los enlaces de imágenes. Si no se define, se usa WEBHOOK_BASE_URL.
   */
  publicBaseUrl: env('PUBLIC_BASE_URL', env('WEBHOOK_BASE_URL', 'http://localhost:3000')).replace(/\/$/, ''),
  telegramApiUrl: env('TELEGRAM_API_URL', 'https://api.telegram.org').replace(/\/$/, ''),
  metaGraphUrl: env('META_GRAPH_URL', 'https://graph.facebook.com').replace(/\/$/, ''),
  uploadsDir: path.resolve(env('UPLOADS_DIR', './data/uploads')),
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', ''),
  sessionSecret: env('SESSION_SECRET', ''),
  secureCookies: env('SECURE_COOKIES', 'false') === 'true',
  evolution: {
    url: env('EVOLUTION_URL', 'http://localhost:8080').replace(/\/$/, ''),
    apiKey: env('EVOLUTION_API_KEY', ''),
  },
  openai: {
    apiKey: env('OPENROUTER_API_KEY', env('OPENAI_API_KEY', '')),
    baseUrl: aiBaseUrl,
    defaultModel: env('OPENROUTER_MODEL', env('OPENAI_MODEL', useOpenRouter ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini')),
    /** Modelos de respaldo (separados por coma): si el principal falla o está saturado, OpenRouter prueba estos en orden. */
    fallbackModels: env('OPENROUTER_FALLBACK_MODELS', '').split(',').map((m) => m.trim()).filter(Boolean),
    summaryModel: env('OPENROUTER_SUMMARY_MODEL', env('OPENAI_SUMMARY_MODEL', useOpenRouter ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini')),
    transcriptionModel: env('OPENROUTER_TRANSCRIPTION_MODEL', env('OPENAI_TRANSCRIPTION_MODEL', useOpenRouter ? 'google/gemini-2.5-flash' : 'gpt-4o-mini-transcribe')),
    timeoutMs: Number(env('OPENROUTER_TIMEOUT_MS', env('OPENAI_TIMEOUT_MS', '45000'))),
  },
  knowledgeSearch: {
    enabled: env('KNOWLEDGE_SEARCH_ENABLED', 'false') === 'true',
    accountIds: rolloutAccounts(env('KNOWLEDGE_SEARCH_ACCOUNT_IDS')),
    model: env('OPENROUTER_EMBEDDING_MODEL', useOpenRouter ? 'openai/text-embedding-3-small' : 'text-embedding-3-small'),
  },
  knowledgeMonitor: {
    enabled: env('KNOWLEDGE_MONITOR_ENABLED','true') === 'true',
    pendingMinutes: monitorLimit('KNOWLEDGE_ALERT_PENDING_MINUTES',15,1440),
    fallbackRatio: monitorLimit('KNOWLEDGE_ALERT_FALLBACK_RATIO',0.05,1),
    minAttempts: monitorLimit('KNOWLEDGE_ALERT_MIN_ATTEMPTS',20,10000),
    latencyMs: monitorLimit('KNOWLEDGE_ALERT_P95_MS',10000,300000),
    hourlyUsd: monitorLimit('KNOWLEDGE_ALERT_HOURLY_USD',5,100000),
  },
  logRetentionDays: Number(env('LOG_RETENTION_DAYS', '30')),
  /**
   * Proxies delante del backend en los que se confía para conocer la IP real (X-Forwarded-For).
   * 1 = solo el proxy inmediato (Caddy). 0 = ninguno (backend expuesto directamente).
   * Confiar en todos permitiría falsear la IP y saltarse los límites por IP.
   */
  trustProxyHops: Number(env('TRUST_PROXY_HOPS', '1')),
  /** Permitir webhooks salientes hacia redes internas (solo para pruebas o redes controladas). */
  emailPollSeconds: Math.max(15, Number(env('EMAIL_POLL_SECONDS', '60'))),
  allowPrivateWebhooks: env('ALLOW_PRIVATE_WEBHOOKS', 'false') === 'true',
  schedulerIntervalMs: Number(env('SCHEDULER_INTERVAL_MS', '5000')),
  /** Correo saliente (verificación, recuperación de contraseña, avisos). Sin SMTP_URL, los correos van al registro. */
  mail: {
    smtpUrl: env('SMTP_URL', ''),
    from: env('MAIL_FROM', 'Chatbots <no-responder@localhost>'),
  },
  /** Autoregistro de empresas. */
  signup: {
    enabled: env('SIGNUP_ENABLED', 'true') === 'true',
    trialDays: Number(env('TRIAL_DAYS', '14')),
    /** Exigir correo verificado para conectar canales reales. Sin SMTP conviene "false". */
    requireEmail: env('SIGNUP_REQUIRE_EMAIL', 'true') === 'true',
    /** Correo del superadmin para avisos (cuentas nuevas, pruebas que vencen, gasto alto). */
    superadminEmail: env('SUPERADMIN_EMAIL', ''),
    /** Límites de la prueba gratuita (0 = sin límite). Evitan que una prueba sin tarjeta gaste IA sin tope. */
    trialLimits: {
      messages: Number(env('TRIAL_MAX_MESSAGES', '300')),
      channels: Number(env('TRIAL_MAX_CHANNELS', '2')),
      users: Number(env('TRIAL_MAX_USERS', '3')),
      chatbots: Number(env('TRIAL_MAX_CHATBOTS', '2')),
    },
    /** Direcciones públicas de tus términos y tu aviso de privacidad (se enlazan en el registro). */
    termsUrl: env('TERMS_URL', ''),
    privacyUrl: env('PRIVACY_URL', ''),
    /** Contacto que ve el cliente cuando su cuenta está pausada. */
    supportContact: env('SUPPORT_CONTACT', ''),
  },
  /** Cobro automático de suscripciones. Cada proveedor se activa con sus claves; si ninguno está, el cobro sigue siendo manual. */
  billing: {
    graceDays: Number(env('BILLING_GRACE_DAYS', '5')),
    stripe: {
      secretKey: env('STRIPE_SECRET_KEY', ''),
      webhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
      apiUrl: env('STRIPE_API_URL', 'https://api.stripe.com'),
    },
    mercadopago: {
      accessToken: env('MERCADOPAGO_ACCESS_TOKEN', ''),
      webhookSecret: env('MERCADOPAGO_WEBHOOK_SECRET', ''),
      apiUrl: env('MERCADOPAGO_API_URL', 'https://api.mercadopago.com'),
    },
  },
  /** Monitoreo: ping periódico (healthchecks.io, Uptime Kuma…) y aviso por webhook (Slack, ntfy, Telegram…) además del correo. */
  monitor: {
    heartbeatUrl: env('HEARTBEAT_URL', ''),
    alertWebhookUrl: env('ALERT_WEBHOOK_URL', ''),
    backupDir: env('BACKUP_DIR', '/backups'),
    /** Horas sin respaldo nuevo antes de avisar. */
    backupMaxAgeHours: Number(env('BACKUP_MAX_AGE_HOURS', '36')),
    version: env('APP_VERSION', 'dev'),
  },
  /** Aviso (sin bloqueo) cuando una cuenta supera este gasto de IA en el mes, en USD. 0 = sin aviso. */
  aiAlertUsdPerAccount: Number(env('AI_ALERT_USD_PER_ACCOUNT', '0')),
};

export function assertProductionConfig(): string[] {
  const problems: string[] = [];
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD no está definido (no se creará el superadministrador inicial)');
  if (!config.publicBaseUrl.startsWith('https://')) problems.push('PUBLIC_BASE_URL no es HTTPS: Telegram, Messenger e Instagram no podrán enviar webhooks ni recibir imágenes');
  if (!config.sessionSecret || config.sessionSecret.length < 16) problems.push('SESSION_SECRET debe tener al menos 16 caracteres');
  if (!config.openai.apiKey) problems.push('OPENROUTER_API_KEY (o OPENAI_API_KEY) no está definido (el bot no podrá responder)');
  if (!config.evolution.apiKey) problems.push('EVOLUTION_API_KEY no está definido (no se podrán enviar mensajes)');
  if (config.signup.enabled && !config.mail.smtpUrl) problems.push('SMTP_URL no está definido: los correos de verificación y recuperación solo quedan en el registro');
  return problems;
}

/** Empty pilot list preserves the global rollout; false disables all accounts. */
export function semanticEnabledFor(accountId: string) {
  return config.knowledgeSearch.enabled && (!config.knowledgeSearch.accountIds.length || config.knowledgeSearch.accountIds.includes(accountId));
}
