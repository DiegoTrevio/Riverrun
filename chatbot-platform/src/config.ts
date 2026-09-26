import path from 'node:path';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

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
    apiKey: env('OPENAI_API_KEY', ''),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    defaultModel: env('OPENAI_MODEL', 'gpt-4.1-mini'),
    summaryModel: env('OPENAI_SUMMARY_MODEL', 'gpt-4.1-mini'),
    transcriptionModel: env('OPENAI_TRANSCRIPTION_MODEL', 'gpt-4o-mini-transcribe'),
    timeoutMs: Number(env('OPENAI_TIMEOUT_MS', '45000')),
  },
  logRetentionDays: Number(env('LOG_RETENTION_DAYS', '30')),
  /**
   * Proxies delante del backend en los que se confía para conocer la IP real (X-Forwarded-For).
   * 1 = solo el proxy inmediato (Caddy). 0 = ninguno (backend expuesto directamente).
   * Confiar en todos permitiría falsear la IP y saltarse los límites por IP.
   */
  trustProxyHops: Number(env('TRUST_PROXY_HOPS', '1')),
};

export function assertProductionConfig(): string[] {
  const problems: string[] = [];
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD no está definido (no se creará el superadministrador inicial)');
  if (!config.publicBaseUrl.startsWith('https://')) problems.push('PUBLIC_BASE_URL no es HTTPS: Telegram, Messenger e Instagram no podrán enviar webhooks ni recibir imágenes');
  if (!config.sessionSecret || config.sessionSecret.length < 16) problems.push('SESSION_SECRET debe tener al menos 16 caracteres');
  if (!config.openai.apiKey) problems.push('OPENAI_API_KEY no está definido (el bot no podrá responder)');
  if (!config.evolution.apiKey) problems.push('EVOLUTION_API_KEY no está definido (no se podrán enviar mensajes)');
  return problems;
}
