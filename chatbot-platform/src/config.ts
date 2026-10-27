import path from 'node:path';
import { validateConfig } from './config-check.js';
import { parseAlertMute } from './alert-mute.js';

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

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Un valor desconocido se rechaza: un typo que dejara los envíos reales en una prueba sería peor que no arrancar. */
function outboundMode(value: string): 'live' | 'sandbox' {
  if (value === 'live' || value === 'sandbox') return value;
  throw new Error('OUTBOUND_MODE debe ser "live" o "sandbox" (valor recibido: ' + JSON.stringify(value.slice(0, 20)) + ').');
}

function quotePdfBackend(value: string): 'soffice' | 'gotenberg' | 'fake' {
  if (value === 'soffice' || value === 'gotenberg' || value === 'fake') return value;
  throw new Error('QUOTE_PDF_BACKEND debe ser "soffice", "gotenberg" o "fake" (valor recibido: ' + JSON.stringify(value.slice(0, 20)) + ').');
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
  /** App de Meta de la plataforma: cada negocio conecta Facebook e Instagram con un botón. */
  meta: {
    appId: env('META_APP_ID', ''),
    appSecret: env('META_APP_SECRET', ''),
    /** Configuración de «Facebook Login for Business» (opcional; si falta se piden los permisos uno por uno). */
    configId: env('META_CONFIG_ID', ''),
    /** Token que Meta envía al verificar el webhook; vacío = derivado de la clave del servidor. */
    verifyToken: env('META_VERIFY_TOKEN', ''),
    graphVersion: env('META_GRAPH_VERSION', 'v21.0'),
    dialogUrl: env('META_DIALOG_URL', 'https://www.facebook.com').replace(/\/$/, ''),
  },
  /** Base de la API de Zernio (https://zernio.com/api + /v1). */
  zernioApiUrl: env('ZERNIO_API_URL', 'https://zernio.com/api/v1').replace(/\/$/, ''),
  uploadsDir: path.resolve(env('UPLOADS_DIR', './data/uploads')),
  /** Cotizaciones: el Word del negocio se convierte a PDF con LibreOffice (o con un servicio Gotenberg si se configura). */
  quotes: {
    pdfBackend: quotePdfBackend(env('QUOTE_PDF_BACKEND', env('QUOTE_PDF_URL') ? 'gotenberg' : 'soffice')),
    pdfUrl: env('QUOTE_PDF_URL').replace(/\/$/, ''),
    sofficePath: env('SOFFICE_PATH', 'soffice'),
    timeoutMs: Number(env('QUOTE_PDF_TIMEOUT_MS', '60000')),
  },
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', ''),
  sessionSecret: env('SESSION_SECRET', ''),
  secureCookies: env('SECURE_COOKIES', 'false') === 'true',
  evolution: {
    url: env('EVOLUTION_URL', 'http://localhost:8080').replace(/\/$/, ''),
    apiKey: env('EVOLUTION_API_KEY', ''),
    /** Imagen configurada en docker-compose.yml (la recibe también el backend para compararla con la versión que responde). */
    image: env('EVOLUTION_IMAGE', ''),
  },
  openai: {
    apiKey: env('OPENROUTER_API_KEY', env('OPENAI_API_KEY', '')),
    baseUrl: aiBaseUrl,
    defaultModel: env('OPENROUTER_MODEL', env('OPENAI_MODEL', useOpenRouter ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini')),
    /** Modelos de respaldo (separados por coma): si el principal falla o está saturado, OpenRouter prueba estos en orden. */
    // "none" desactiva el modelo de respaldo.
    fallbackModels: env('OPENROUTER_FALLBACK_MODELS', '').split(',').map((m) => m.trim()).filter((m) => m && m !== 'none'),
    summaryModel: env('OPENROUTER_SUMMARY_MODEL', env('OPENAI_SUMMARY_MODEL', useOpenRouter ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini')),
    transcriptionModel: env('OPENROUTER_TRANSCRIPTION_MODEL', env('OPENAI_TRANSCRIPTION_MODEL', useOpenRouter ? 'google/gemini-2.5-flash' : 'gpt-4o-mini-transcribe')),
    /** Lee las fotos y los PDF que mandan los clientes (necesita un modelo que vea imágenes y documentos). */
    mediaModel: env('OPENROUTER_MEDIA_MODEL', env('OPENAI_MEDIA_MODEL', useOpenRouter ? 'google/gemini-2.5-flash' : 'gpt-4.1-mini')),
    timeoutMs: Number(env('OPENROUTER_TIMEOUT_MS', env('OPENAI_TIMEOUT_MS', '45000'))),
  },
  knowledgeSearch: {
    forceOff: env('KNOWLEDGE_SEARCH_FORCE_OFF','false')==='true',
    minSimilarity: monitorLimit('KNOWLEDGE_MIN_SIMILARITY',0.25,1),
    pricePerMillion: env('EMBEDDING_PRICE_PER_MILLION') ? monitorLimit('EMBEDDING_PRICE_PER_MILLION',0,10000) : null as number|null,
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
  /** Días que se conserva el detalle técnico de cada respuesta de la IA (después solo queda consumo y costo). */
  aiRunDetailDays: Number(env('AI_RUN_DETAIL_DAYS', '14')),
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
  /** Tiempo máximo de una tarea programada (recordatorio, campaña, sincronización…) antes de cortarla y reintentarla. */
  jobTimeoutMs: Math.max(1000, Number(env('JOB_TIMEOUT_MS', '180000')) || 180000),
  /** Vigilante: un bucle de trabajo sin avanzar este tiempo, o el proceso bloqueado, hacen que se reinicie. WATCHDOG=off lo apaga. */
  watchdog: {
    enabled: env('WATCHDOG', 'on') !== 'off',
    stallMs: Math.max(60_000, Number(env('WATCHDOG_STALL_MS', '600000')) || 600000),
    blockMs: Math.max(10_000, Number(env('WATCHDOG_BLOCK_MS', '60000')) || 60000),
  },
  /** Al apagar: tiempo máximo para terminar lo que está en curso (menor que stop_grace_period de compose, 300 s). */
  shutdownTimeoutMs: Math.max(1000, Number(env('SHUTDOWN_TIMEOUT_MS', '240000')) || 240000),
  queue: {
    concurrency: Math.max(1, Math.min(6, Number(env('QUEUE_CONCURRENCY', '2')) || 2)),
    attempts: Math.max(1, Math.min(20, Number(env('QUEUE_MAX_ATTEMPTS', '3')) || 3)),
    retryMs: Math.max(50, Number(env('QUEUE_RETRY_MS', '60000')) || 60000),
    maxRetryMs: Math.max(50, Number(env('QUEUE_MAX_RETRY_MS', '900000')) || 900000),
    pollMs: Math.max(50, Number(env('QUEUE_POLL_MS', '500')) || 500),
    role: env('PROCESS_ROLE', 'all'),
  },
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
    /** Lo no urgente llega en un solo correo al día (false: un correo por aviso, como antes). */
    superadminDigest: env('SUPERADMIN_DIGEST', 'true') !== 'false',
    /** Hora de México desde la que sale el resumen diario. */
    superadminDigestHour: Math.min(23, Math.max(0, Number(env('SUPERADMIN_DIGEST_HOUR', '8')) || 0)),
    /** Límites de la prueba gratuita (0 = sin límite). Evitan que una prueba sin tarjeta gaste IA sin tope. */
    trialLimits: {
      messages: Number(env('TRIAL_MAX_MESSAGES', '300')),
      channels: Number(env('TRIAL_MAX_CHANNELS', '2')),
      users: Number(env('TRIAL_MAX_USERS', '3')),
      chatbots: Number(env('TRIAL_MAX_CHATBOTS', '2')),
      socialAccounts: Number(env('TRIAL_MAX_SOCIAL_ACCOUNTS', '2')),
    },
    /** Direcciones públicas de tus términos y tu aviso de privacidad (se enlazan en el registro). */
    termsUrl: env('TERMS_URL', ''),
    privacyUrl: env('PRIVACY_URL', ''),
    /** Aviso de privacidad propio (/privacidad): quién es el responsable y dónde se ejercen los derechos ARCO. */
    privacyCompany: env('PRIVACY_COMPANY', ''),
    privacyAddress: env('PRIVACY_ADDRESS', ''),
    privacyContact: env('PRIVACY_CONTACT', ''),
    /** Versión de los términos que se acepta al registrarse (p. ej. "2026-10"); se guarda con cada aceptación. */
    termsVersion: env('TERMS_VERSION', ''),
    /** Dominios de correo que no pueden registrarse, además de la lista de correos desechables (separados por comas). */
    blockedDomains: env('SIGNUP_BLOCKED_DOMAINS', '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    /** Captcha de Cloudflare Turnstile en el registro (opcional: con las dos claves se activa). */
    turnstile: {
      siteKey: env('TURNSTILE_SITE_KEY', ''),
      secretKey: env('TURNSTILE_SECRET_KEY', ''),
      verifyUrl: env('TURNSTILE_VERIFY_URL', 'https://challenges.cloudflare.com/turnstile/v0/siteverify'),
    },
    /** Contacto que ve el cliente cuando su cuenta está pausada. */
    supportContact: env('SUPPORT_CONTACT', ''),
  },
  /** Cobro automático de suscripciones. Cada proveedor se activa con sus claves; si ninguno está, el cobro sigue siendo manual. */
  billing: {
    graceDays: Number(env('BILLING_GRACE_DAYS', '5')),
    /** Días que se conserva una cuenta pausada sola (prueba vencida o falta de pago) antes de borrarla. 0 = nunca se borra. */
    retentionDays: Number(env('ACCOUNT_RETENTION_DAYS', '90')),
    /** Días en pausa por falta de pago tras los que se cancela la suscripción en el proveedor (deja de reintentar cobrar). 0 = nunca. */
    cancelAfterPauseDays: Number(env('BILLING_CANCEL_AFTER_PAUSE_DAYS', '30')),
    /** IVA que se suma al precio de los planes (los precios se capturan sin IVA). 0 = no se suma. */
    taxPercent: Number(env('BILLING_TAX_PERCENT', '16')),
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
    /** Facturas electrónicas (CFDI 4.0) con Facturapi. Sin clave no se emiten (quedan pendientes hasta configurarla). */
    cfdi: {
      apiKey: env('FACTURAPI_API_KEY', ''),
      apiUrl: env('FACTURAPI_API_URL', 'https://www.facturapi.io/v2'),
      /** Clave de producto/servicio del SAT: 81112106 = Proveedores de servicios de aplicación (software como servicio). */
      productKey: env('CFDI_PRODUCT_KEY', '81112106'),
      /** Código postal del domicilio fiscal del emisor (lugar de expedición de la factura global). */
      issuerZip: env('CFDI_ISSUER_ZIP', ''),
      /** Intentos ante fallas del PAC antes de dejar el CFDI con error y avisar. */
      maxAttempts: Number(env('CFDI_MAX_ATTEMPTS', '8')),
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
    /** Token para /health/functional y /metrics (cabecera Authorization: Bearer). Vacío = esos endpoints no existen (404). */
    healthToken: env('HEALTH_TOKEN', ''),
    /** Componentes cuyas alertas se registran pero no se envían: ALERT_MUTE=backup,disk (sin fecha) o backup=AAAA-MM-DDTHH:MM:SSZ (vence). */
    alertMute: parseAlertMute(env('ALERT_MUTE', '')).mutes,
    /** Minutos que una incidencia puede seguir abierta antes de enviar un aviso de escalamiento. */
    escalateMinutes: monitorLimit('ALERT_ESCALATE_MINUTES', 60, 10080),
    /** Memoria residente del proceso que avisa, en MB (0 = sin aviso). Pensado para un VPS de ~2 GB. */
    rssWarnMb: monitorLimit('RESOURCE_WARN_RSS_MB', 1024, 65536),
  },
  /**
   * Salida real de mensajes. `sandbox` (staging) bloquea todo envío a WhatsApp, correo o webhooks salvo a los destinos de
   * OUTBOUND_SANDBOX_ALLOW (teléfonos o correos de prueba). El simulador del panel nunca se bloquea.
   */
  outbound: {
    mode: outboundMode(env('OUTBOUND_MODE', 'live')),
    allow: list(env('OUTBOUND_SANDBOX_ALLOW', '')),
  },
  /**
   * Umbrales de la vigilancia de WhatsApp (sesiones y entregas). Son heurísticas: ajústalas con datos de tu operación
   * sin tocar código. Ver docs/evolution-api.md → Monitoreo preventivo.
   */
  whatsappAlerts: {
    /** Fracción de los canales vinculados que, desconectados tras un cambio de versión, cuenta como falla. */
    downRatio: Number(env('WHATSAPP_ALERT_DOWN_RATIO', '0.5')),
    /** Envíos fallidos en 15 minutos que avisan. */
    sendFailures: Number(env('WHATSAPP_ALERT_SEND_FAILURES', '5')),
    /** Horas tras un cambio de versión de Evolution en las que se vigilan desconexiones y fallos. */
    postUpdateHours: Number(env('WHATSAPP_POST_UPDATE_HOURS', '24')),
  },
  /** Aviso (sin bloqueo) cuando una cuenta supera este gasto de IA en el mes, en USD. 0 = sin aviso. */
  aiAlertUsdPerAccount: Number(env('AI_ALERT_USD_PER_ACCOUNT', '0')),
  /**
   * Cobros de los negocios a sus clientes y sus recordatorios de pago. Los días y la hora son con los que nace la
   * configuración de cada cuenta; cada negocio los cambia en Cobros → Ajustes.
   */
  receivables: {
    enabled: env('RECEIVABLES_ENABLED', 'true') !== 'false',
    /** Días respecto al vencimiento (negativo = antes): "-3,0,3,7". */
    defaultReminders: receivableDays(env('RECEIVABLE_DEFAULT_REMINDERS', '-3,0,3,7')),
    defaultSendAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(env('RECEIVABLE_DEFAULT_SEND_AT', '10:00')) ? env('RECEIVABLE_DEFAULT_SEND_AT', '10:00') : '10:00',
    /** Tope de recordatorios automáticos por cobro. */
    maxReminders: Math.max(1, Math.min(20, Number(env('RECEIVABLE_MAX_REMINDERS', '8')) || 8)),
    /** «Enviar recordatorio ahora» por cobro y por día. */
    manualRemindPerDay: Math.max(1, Math.min(20, Number(env('RECEIVABLE_MANUAL_REMIND_PER_DAY', '3')) || 3)),
    /** Pagos recurrentes: con cuántos días de anticipación se crea el cobro de cada periodo. */
    recurringLeadDays: Math.max(0, Math.min(60, Number.isFinite(Number(env('RECEIVABLE_RECURRING_LEAD_DAYS', '7'))) ? Math.trunc(Number(env('RECEIVABLE_RECURRING_LEAD_DAYS', '7'))) : 7)),
  },
};

/** "-3,0,3,7" → [-3, 0, 3, 7] (enteros entre -60 y 120, sin repetir, ordenados). Algo inválido usa los de siempre. */
export function receivableDays(raw: string): number[] {
  const days = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < -60 || d > 120)) return [-3, 0, 3, 7];
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Compatibilidad: lista de problemas como texto. La validación completa (niveles, entorno y cómo corregir)
 * está en config-check.ts; el arranque la aplica antes de importar este módulo.
 */
export function assertProductionConfig(): string[] {
  return validateConfig({ ...process.env, RIVERRUN_ENV: 'production' }).issues.filter((i) => i.level !== 'optional').map((i) => i.message);
}

/** Empty pilot list preserves the global rollout; false disables all accounts. */
export function semanticEnabledFor(accountId: string) {
  return config.knowledgeSearch.enabled && (!config.knowledgeSearch.accountIds.length || config.knowledgeSearch.accountIds.includes(accountId));
}
