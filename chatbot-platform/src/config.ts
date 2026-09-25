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
};

export function assertProductionConfig(): string[] {
  const problems: string[] = [];
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD no está definido');
  if (!config.sessionSecret || config.sessionSecret.length < 16) problems.push('SESSION_SECRET debe tener al menos 16 caracteres');
  if (!config.openai.apiKey) problems.push('OPENAI_API_KEY no está definido (el bot no podrá responder)');
  if (!config.evolution.apiKey) problems.push('EVOLUTION_API_KEY no está definido (no se podrán enviar mensajes)');
  return problems;
}
