import path from 'node:path';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
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
    summaryModel: env('OPENROUTER_SUMMARY_MODEL', env('OPENAI_SUMMARY_MODEL', useOpenRouter ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini')),
    transcriptionModel: env('OPENROUTER_TRANSCRIPTION_MODEL', env('OPENAI_TRANSCRIPTION_MODEL', useOpenRouter ? 'google/gemini-2.5-flash' : 'gpt-4o-mini-transcribe')),
    timeoutMs: Number(env('OPENROUTER_TIMEOUT_MS', env('OPENAI_TIMEOUT_MS', '45000'))),
  },
  knowledgeSearch: {
    enabled: env('KNOWLEDGE_SEARCH_ENABLED', 'false') === 'true',
    model: env('OPENROUTER_EMBEDDING_MODEL', useOpenRouter ? 'openai/text-embedding-3-small' : 'text-embedding-3-small'),
  },
  logRetentionDays: Number(env('LOG_RETENTION_DAYS', '30')),
  /**
   * Proxies delante del backend en los que se confía para conocer la IP real (X-Forwarded-For).
   * 1 = solo el proxy inmediato (Caddy). 0 = ninguno (backend expuesto directamente).
   * Confiar en todos permitiría falsear la IP y saltarse los límites por IP.
   */
  trustProxyHops: Number(env('TRUST_PROXY_HOPS', '1')),
  /** Permitir webhooks salientes hacia redes internas (solo para pruebas o redes controladas). */
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
    /** Contacto que ve el cliente cuando su cuenta está pausada. */
    supportContact: env('SUPPORT_CONTACT', ''),
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
