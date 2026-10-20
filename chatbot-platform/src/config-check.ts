/**
 * Validación de la configuración (variables de entorno) antes de arrancar y para el panel de Sistema.
 *
 * Niveles:
 *  - critical: arrancar sería inseguro o el servidor no podría funcionar (impide el arranque en modo estricto).
 *  - warning:  arranca, pero alguna función queda limitada, insegura o aparentemente activa sin funcionar.
 *  - optional: servicio opcional desactivado; no afecta al resto.
 *
 * Los requisitos dependen del entorno (producción, desarrollo, pruebas) y de las funciones realmente activadas:
 * las credenciales de un servicio opcional solo se exigen si ese servicio se configuró.
 *
 * Módulo puro: no importa config.ts (que lanza errores al importarse con algunos valores inválidos) ni la base de
 * datos, para poder correr primero. Nunca incluye valores de variables en los mensajes.
 */
import { z } from 'zod';
import { parseAlertMute } from './alert-mute.js';
import { EVOLUTION_EXPECTED, assessVersion, imageVersion, isPinned, parseImageRef } from './evolution/compat.js';

export type Level = 'critical' | 'warning' | 'optional';
export type RuntimeEnv = 'production' | 'development' | 'test';
export type Area = 'core' | 'security' | 'ai' | 'whatsapp' | 'email' | 'billing' | 'integrations' | 'monitoring' | 'knowledge';
export type Env = Record<string, string | undefined>;

export interface ConfigIssue {
  id: string;
  level: Level;
  area: Area;
  vars: string[];
  message: string;
  fix: string;
}

export interface ServiceConfig {
  id: string;
  label: string;
  area: Area;
  /** configured: tiene lo necesario · disabled: opcional apagado · incomplete: faltan o sobran piezas · invalid: valores no válidos */
  state: 'configured' | 'disabled' | 'incomplete' | 'invalid';
  detail: string;
}

export interface ConfigReport {
  env: RuntimeEnv;
  mode: 'strict' | 'warn';
  checked_at: string;
  status: 'ok' | 'warn' | 'fail';
  counts: Record<Level, number>;
  issues: ConfigIssue[];
  services: ServiceConfig[];
}

/** Variables cuyo valor es secreto: nunca se muestran (ni en el panel ni en los registros). */
export const SECRET_VARS = [
  'DATABASE_URL', 'POSTGRES_PASSWORD', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'EVOLUTION_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY',
  'SMTP_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET', 'ZERNIO_API_KEY', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'BACKUP_PASSPHRASE', 'BACKUP_S3_SECRET', 'HEARTBEAT_URL', 'ALERT_WEBHOOK_URL',
] as const;

/** Valores de ejemplo conocidos (completos, no prefijos: un secreto aleatorio puede empezar con "x" o "test"). */
const PLACEHOLDER = /^(cambia-esta-clave.*|changeme|change-me|secret|secreto|password|contrase(n|ñ)a|admin|123456\d*|test|x+)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|[a-z0-9-]+$)/i; // nombres sin punto = servicios de Docker

/** Entorno de ejecución: RIVERRUN_ENV manda; si no, NODE_ENV (la imagen de Docker usa production). */
export function runtimeEnv(env: Env = process.env): RuntimeEnv {
  const explicit = (env.RIVERRUN_ENV ?? '').trim();
  if (explicit === 'production' || explicit === 'development' || explicit === 'test') return explicit;
  const node = (env.NODE_ENV ?? '').trim();
  if (node === 'production') return 'production';
  if (node === 'test') return 'test';
  return 'development';
}

const urlSchema = (protocols: string[]) =>
  z.string().refine((s) => {
    try {
      return protocols.includes(new URL(s).protocol);
    } catch {
      return false;
    }
  });

const HTTP_URL = urlSchema(['http:', 'https:']);
const PG_URL = urlSchema(['postgres:', 'postgresql:']);
const SMTP = urlSchema(['smtp:', 'smtps:']);
const EMAIL = z.string().email();

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
};

/** Números: el rango coincide con el uso real (un NaN aquí acaba en bucles de 1 ms o consultas rotas). */
const NUMBERS: { name: string; min: number; max: number; int?: boolean; area: Area; what: string }[] = [
  { name: 'PORT', min: 1, max: 65535, int: true, area: 'core', what: 'puerto del servidor' },
  { name: 'SCHEDULER_INTERVAL_MS', min: 500, max: 600000, int: true, area: 'core', what: 'intervalo de tareas programadas (ms)' },
  {name:'QUEUE_CONCURRENCY',min:1,max:6,int:true,area:'core',what:'concurrencia inicial de workers'},
  {name:'QUEUE_MAX_ATTEMPTS',min:1,max:20,int:true,area:'core',what:'intentos máximos de la cola'},
  {name:'QUEUE_RETRY_MS',min:50,max:86400000,int:true,area:'core',what:'espera inicial de reintento (ms)'},
  {name:'QUEUE_MAX_RETRY_MS',min:50,max:86400000,int:true,area:'core',what:'espera máxima de reintento (ms)'},
  {name:'QUEUE_POLL_MS',min:50,max:60000,int:true,area:'core',what:'intervalo de revisión de cola (ms)'},
  {name:'KNOWLEDGE_MIN_SIMILARITY',min:0,max:1,area:'knowledge',what:'confianza mínima de coincidencia'},
  {name:'EMBEDDING_PRICE_PER_MILLION',min:0,max:10000,area:'knowledge',what:'precio estimado de embeddings'},
  { name: 'EMAIL_POLL_SECONDS', min: 1, max: 86400, int: true, area: 'email', what: 'revisión de buzones (s)' },
  { name: 'LOG_RETENTION_DAYS', min: 1, max: 3650, int: true, area: 'core', what: 'días de registros' },
  { name: 'AI_RUN_DETAIL_DAYS', min: 1, max: 3650, int: true, area: 'ai', what: 'días de detalle de IA' },
  { name: 'TRUST_PROXY_HOPS', min: 0, max: 10, int: true, area: 'security', what: 'proxies de confianza' },
  { name: 'OPENROUTER_TIMEOUT_MS', min: 1000, max: 600000, int: true, area: 'ai', what: 'tiempo máximo de la IA (ms)' },
  { name: 'OPENAI_TIMEOUT_MS', min: 1000, max: 600000, int: true, area: 'ai', what: 'tiempo máximo de la IA (ms)' },
  { name: 'TRIAL_DAYS', min: 0, max: 3650, int: true, area: 'core', what: 'días de prueba' },
  { name: 'TRIAL_MAX_MESSAGES', min: 0, max: 1e9, int: true, area: 'core', what: 'límite de mensajes de la prueba' },
  { name: 'TRIAL_MAX_CHANNELS', min: 0, max: 1e6, int: true, area: 'core', what: 'límite de canales de la prueba' },
  { name: 'TRIAL_MAX_USERS', min: 0, max: 1e6, int: true, area: 'core', what: 'límite de usuarios de la prueba' },
  { name: 'TRIAL_MAX_CHATBOTS', min: 0, max: 1e6, int: true, area: 'core', what: 'límite de asistentes de la prueba' },
  { name: 'TRIAL_MAX_SOCIAL_ACCOUNTS', min: 0, max: 1e6, int: true, area: 'core', what: 'límite de redes sociales conectadas de la prueba' },
  { name: 'BILLING_GRACE_DAYS', min: 0, max: 365, int: true, area: 'billing', what: 'días de gracia de cobro' },
  { name: 'BACKUP_MAX_AGE_HOURS', min: 1, max: 8760, area: 'monitoring', what: 'horas sin respaldo antes de avisar' },
  { name: 'AI_ALERT_USD_PER_ACCOUNT', min: 0, max: 1e6, area: 'ai', what: 'aviso de gasto de IA (USD)' },
  // Mismos límites que config.ts (allí un valor fuera de rango detiene el proceso).
  { name: 'KNOWLEDGE_ALERT_PENDING_MINUTES', min: 0, max: 1440, area: 'knowledge', what: 'umbral de supervisión' },
  { name: 'KNOWLEDGE_ALERT_FALLBACK_RATIO', min: 0, max: 1, area: 'knowledge', what: 'umbral de supervisión' },
  { name: 'KNOWLEDGE_ALERT_MIN_ATTEMPTS', min: 0, max: 10000, area: 'knowledge', what: 'umbral de supervisión' },
  { name: 'KNOWLEDGE_ALERT_P95_MS', min: 0, max: 300000, area: 'knowledge', what: 'umbral de supervisión' },
  { name: 'KNOWLEDGE_ALERT_HOURLY_USD', min: 0, max: 100000, area: 'knowledge', what: 'umbral de supervisión' },
  { name: 'WHATSAPP_ALERT_DOWN_RATIO', min: 0, max: 1, area: 'whatsapp', what: 'fracción de sesiones caídas que avisa tras actualizar' },
  { name: 'WHATSAPP_ALERT_SEND_FAILURES', min: 1, max: 10000, int: true, area: 'whatsapp', what: 'envíos fallidos en 15 min que avisan' },
  { name: 'QUOTE_PDF_TIMEOUT_MS', min: 5000, max: 600000, int: true, area: 'core', what: 'tiempo máximo para generar el PDF de una cotización (ms)' },
  { name: 'WHATSAPP_POST_UPDATE_HOURS', min: 1, max: 720, int: true, area: 'whatsapp', what: 'horas de vigilancia tras cambiar la versión de Evolution' },
];

/** Interruptores que el código compara con 'true' exacto: cualquier otro valor los apaga sin aviso. */
const BOOLEANS: { name: string; def: boolean; area: Area }[] = [
  { name: 'SECURE_COOKIES', def: false, area: 'security' },
  { name: 'SIGNUP_ENABLED', def: true, area: 'core' },
  { name: 'SIGNUP_REQUIRE_EMAIL', def: true, area: 'email' },
  { name: 'KNOWLEDGE_SEARCH_ENABLED', def: false, area: 'knowledge' },
  {name:'KNOWLEDGE_SEARCH_FORCE_OFF',def:false,area:'knowledge'},
  { name: 'KNOWLEDGE_MONITOR_ENABLED', def: true, area: 'knowledge' },
  { name: 'ALLOW_PRIVATE_WEBHOOKS', def: false, area: 'security' },
  { name: 'HTTP_LOG', def: false, area: 'core' },
  { name: 'LOG_DEBUG', def: false, area: 'core' },
];

export function validateConfig(env: Env = process.env, now = new Date()): ConfigReport {
  const rt = runtimeEnv(env);
  const prod = rt === 'production';
  const get = (k: string) => {
    const v = env[k];
    return v === undefined ? '' : String(v);
  };
  const has = (k: string) => get(k) !== '';
  const flag = (k: string, def: boolean) => (has(k) ? get(k) === 'true' : def);
  const issues: ConfigIssue[] = [];
  const services: ServiceConfig[] = [];
  const add = (level: Level, area: Area, id: string, vars: string[], message: string, fix: string) => issues.push({ id, level, area, vars, message, fix });

  /* ------------------------------ Formatos ------------------------------ */
  for (const n of NUMBERS) {
    if (!has(n.name)) continue;
    const raw = get(n.name).trim();
    const value = Number(raw);
    const ok = raw !== '' && Number.isFinite(value) && value >= n.min && value <= n.max && (!n.int || Number.isInteger(value));
    if (!ok) add(
      'critical',
      n.area,
      `number.${n.name}`,
      [n.name],
      `${n.name} (${n.what}) no es válido: debe ser un número${n.int ? ' entero' : ''} entre ${n.min} y ${n.max}.`,
      `Corrige ${n.name} en .env o bórralo para usar el valor por defecto.`,
    );
  }
  for (const b of BOOLEANS) {
    if (!has(b.name) || get(b.name) === 'true' || get(b.name) === 'false') continue;
    add(
      b.name==='KNOWLEDGE_SEARCH_FORCE_OFF'?'critical':'warning',
      b.area,
      `boolean.${b.name}`,
      [b.name],
      `${b.name} no es "true" ni "false": se interpreta como false${b.def ? ' y la función queda apagada (por defecto está encendida)' : ''}.`,
      `Escribe exactamente true o false (en minúsculas) en ${b.name}.`,
    );
  }
  if (has('QUOTE_PDF_BACKEND') && !['soffice', 'gotenberg', 'fake'].includes(get('QUOTE_PDF_BACKEND'))) {
    add('critical', 'core', 'quote_pdf.backend', ['QUOTE_PDF_BACKEND'], 'QUOTE_PDF_BACKEND debe ser "soffice", "gotenberg" o "fake".', 'Bórrala para usar LibreOffice (soffice), o escribe gotenberg y define QUOTE_PDF_URL.');
  }
  if (get('QUOTE_PDF_BACKEND') === 'gotenberg' && !has('QUOTE_PDF_URL')) {
    add('critical', 'core', 'quote_pdf.url', ['QUOTE_PDF_URL'], 'Las cotizaciones usan Gotenberg pero falta QUOTE_PDF_URL.', 'Define QUOTE_PDF_URL (p. ej. http://gotenberg:3000) o borra QUOTE_PDF_BACKEND para usar LibreOffice.');
  }
  if (prod && get('QUOTE_PDF_BACKEND') === 'fake') {
    add('critical', 'core', 'quote_pdf.fake', ['QUOTE_PDF_BACKEND'], 'QUOTE_PDF_BACKEND=fake es solo para pruebas: los clientes recibirían un PDF de prueba.', 'Bórrala en producción.');
  }
  if (has('CONFIG_VALIDATION') && !['strict', 'warn'].includes(get('CONFIG_VALIDATION'))) {
    add(
      'warning',
      'core',
      'config_validation.invalid',
      ['CONFIG_VALIDATION'],
      'CONFIG_VALIDATION debe ser "strict" o "warn": se usa "strict".',
      'Bórrala o usa strict (recomendado).',
    );
  }
  if (has('RIVERRUN_ENV') && !['production', 'development', 'test'].includes(get('RIVERRUN_ENV'))) {
    add(
      'warning',
      'core',
      'riverrun_env.invalid',
      ['RIVERRUN_ENV'],
      'RIVERRUN_ENV debe ser production, development o test: se ignora.',
      'Bórrala (se deduce de NODE_ENV) o corrígela.',
    );
  }

  if(has('PROCESS_ROLE')&&!['all','http','worker'].includes(get('PROCESS_ROLE'))) add('critical','core','process_role.invalid',['PROCESS_ROLE'],'PROCESS_ROLE debe ser all, http o worker.','Corrige el rol antes de arrancar.');
  /* ------------------------------ Base de datos ------------------------------ */
  if (has('DATABASE_URL') && !PG_URL.safeParse(get('DATABASE_URL')).success) {
    add(
      'critical',
      'core',
      'database.url_invalid',
      ['DATABASE_URL'],
      'DATABASE_URL no es una dirección de PostgreSQL válida (postgres://usuario:clave@servidor:5432/base).',
      'Corrige DATABASE_URL. Con Docker la arma docker-compose.yml a partir de POSTGRES_PASSWORD.',
    );
  } else if (prod && !has('DATABASE_URL')) {
    add(
      'warning',
      'core',
      'database.url_default',
      ['DATABASE_URL'],
      'DATABASE_URL no está definido: se usa la base local de desarrollo con la clave de ejemplo.',
      'Define DATABASE_URL (con Docker se define sola).',
    );
  } else if (prod) {
    try {
      const pw = decodeURIComponent(new URL(get('DATABASE_URL')).password);
      if (!pw || pw === 'chatbot' || PLACEHOLDER.test(pw)) add(
        'warning',
        'security',
        'database.weak_password',
        ['DATABASE_URL', 'POSTGRES_PASSWORD'],
        'La base de datos usa una contraseña vacía o de ejemplo.',
        'Cambia la contraseña del usuario de PostgreSQL y actualiza POSTGRES_PASSWORD (no basta con cambiar .env: el volumen guarda la clave anterior).',
      );
    } catch {
      /* ya validado arriba */
    }
  }
  services.push({ id: 'database', label: 'Base de datos (PostgreSQL)', area: 'core', state: issues.some((i) => i.id === 'database.url_invalid') ? 'invalid' : 'configured', detail: has('DATABASE_URL') ? 'Dirección definida' : 'Valor por defecto de desarrollo' });

  /* ------------------------------ Direcciones públicas ------------------------------ */
  const publicUrl = get('PUBLIC_BASE_URL') || get('WEBHOOK_BASE_URL') || 'http://localhost:3000';
  const publicVar = has('PUBLIC_BASE_URL') ? 'PUBLIC_BASE_URL' : 'WEBHOOK_BASE_URL';
  const publicValid = HTTP_URL.safeParse(publicUrl).success;
  if (!publicValid) add(
    'critical',
    'core',
    'public_url.invalid',
    [publicVar],
    `${publicVar} no es una dirección http(s) válida: el panel, los enlaces y los webhooks se arman con ella.`,
    `Escribe la dirección completa, por ejemplo https://bot.tudominio.com (sin espacios ni / final).`,
  );
  const https = publicValid && publicUrl.startsWith('https://');
  if (publicValid && !https && prod) add(
    'warning',
    'core',
    'public_url.not_https',
    ['PUBLIC_BASE_URL'],
    'PUBLIC_BASE_URL no es HTTPS: Telegram, Messenger, Instagram, el chat web, los pagos y Google no podrán enviar webhooks ni mostrar imágenes.',
    'Configura un dominio con ./riverrun install (activa Caddy y HTTPS) o define PUBLIC_BASE_URL=https://….',
  );
  if (has('WEBHOOK_BASE_URL') && !HTTP_URL.safeParse(get('WEBHOOK_BASE_URL')).success) {
    add(
      'critical',
      'whatsapp',
      'webhook_url.invalid',
      ['WEBHOOK_BASE_URL'],
      'WEBHOOK_BASE_URL no es una dirección http(s) válida.',
      'Con Docker debe ser http://backend:3000 (ya viene en docker-compose.yml).',
    );
  }
  const domain = get('DOMAIN').trim().toLowerCase();
  if (publicValid && domain && domain !== 'localhost' && domain.includes('.') && has('PUBLIC_BASE_URL')) {
    const h = host(publicUrl).toLowerCase();
    if (h !== domain && !LOCAL_HOST.test(h)) add(
      'warning',
      'core',
      'domain.mismatch',
      ['DOMAIN', 'PUBLIC_BASE_URL'],
      'DOMAIN y PUBLIC_BASE_URL apuntan a dominios distintos: el certificado HTTPS se pide para DOMAIN pero los enlaces usan PUBLIC_BASE_URL.',
      'Usa el mismo dominio en ambas (o borra PUBLIC_BASE_URL para que se arme con DOMAIN).',
    );
  }
  for (const k of ['TELEGRAM_API_URL', 'META_GRAPH_URL', 'ZERNIO_API_URL', 'STRIPE_API_URL', 'MERCADOPAGO_API_URL', 'OPENROUTER_BASE_URL', 'OPENAI_BASE_URL', 'EVOLUTION_URL']) {
    if (has(k) && !HTTP_URL.safeParse(get(k)).success) {
      const ai = k === 'OPENROUTER_BASE_URL' || k === 'OPENAI_BASE_URL';
      // La URL de la IA se interpreta al cargar la configuración: un valor roto detiene el proceso de todos modos.
      add(
        ai ? 'critical' : 'warning',
        ai ? 'ai' : k === 'EVOLUTION_URL' ? 'whatsapp' : 'integrations',
        `url.${k}`,
        [k],
        `${k} no es una dirección http(s) válida: ese servicio no funcionará.`,
        `Corrige ${k} o bórrala para usar el valor por defecto.`,
      );
    }
  }

  /* ------------------------------ Seguridad ------------------------------ */
  const secret = get('SESSION_SECRET');
  if (!secret) {
    // Sin secreto se usa uno aleatorio por arranque (secret.ts): no es inseguro, pero degrada funciones. Con Zernio sí es
    // crítico: el webhook se firma con un secreto derivado de él y cada proceso tendría uno distinto.
    add(
      get('ZERNIO_API_KEY') ? 'critical' : 'warning',
      'security',
      'session_secret.missing',
      ['SESSION_SECRET'],
      'SESSION_SECRET no está definido: cada reinicio cierra todas las sesiones y los datos cifrados (p. ej. Google Calendar) dejan de poder leerse.',
      'Genera uno con `openssl rand -hex 32`, guárdalo en .env (y fuera del servidor) y reinicia.',
    );
  } else if (secret.length < 16 || PLACEHOLDER.test(secret) || new Set(secret).size < 6) {
    // Aviso y no crítico: hay instalaciones ya en marcha con valores cortos y no deben dejar de arrancar tras actualizar.
    add(
      'warning',
      'security',
      'session_secret.weak',
      ['SESSION_SECRET'],
      'SESSION_SECRET es demasiado corto o predecible: firma las sesiones y cifra los secretos guardados.',
      'Cámbialo con `./riverrun rotate-secret` (genera uno largo; cierra las sesiones del panel y hay que volver a conectar Google Calendar).',
    );
  } else if (secret.length < 32 && prod) {
    add(
      'warning',
      'security',
      'session_secret.short',
      ['SESSION_SECRET'],
      'SESSION_SECRET tiene menos de 32 caracteres.',
      'Se recomienda `openssl rand -hex 32` (64 caracteres).',
    );
  }
  const adminPw = get('ADMIN_PASSWORD');
  if (!adminPw) {
    add(
      prod ? 'warning' : 'optional',
      'security',
      'admin_password.missing',
      ['ADMIN_PASSWORD'],
      'ADMIN_PASSWORD no está definido: no se crea ni se recupera el superadministrador desde .env (si ya existe, sigue funcionando).',
      'Define ADMIN_PASSWORD para crear o recuperar el acceso del superadministrador.',
    );
  } else if (/^cambia-/i.test(adminPw)) {
    // auth.ts ya se niega a crear o actualizar al superadministrador con esta clave cuando hay HTTPS; sin HTTPS sigue
    // funcionando, así que es aviso (no bloquea) y el panel lo muestra.
    add(
      'warning',
      'security',
      'admin_password.placeholder',
      ['ADMIN_PASSWORD'],
      'ADMIN_PASSWORD sigue siendo la de ejemplo de .env.example (es pública).',
      'Cámbiala en .env por una contraseña propia y reinicia (o ejecuta ./riverrun install, que genera una).',
    );
  } else if (adminPw.length < 8) {
    add(
      'warning',
      'security',
      'admin_password.short',
      ['ADMIN_PASSWORD'],
      'ADMIN_PASSWORD tiene menos de 8 caracteres (el mínimo que el panel exige a cualquier usuario).',
      'Usa una contraseña de al menos 12 caracteres.',
    );
  }
  if (prod && https && !flag('SECURE_COOKIES', false)) add(
    'warning',
    'security',
    'cookies.insecure',
    ['SECURE_COOKIES'],
    'El panel usa HTTPS pero SECURE_COOKIES no es true: la cookie de sesión también viajaría por http.',
    'Pon SECURE_COOKIES=true.',
  );
  if (flag('SECURE_COOKIES', false) && publicValid && !https && !LOCAL_HOST.test(host(publicUrl))) add(
    'warning',
    'security',
    'cookies.secure_over_http',
    ['SECURE_COOKIES', 'PUBLIC_BASE_URL'],
    'SECURE_COOKIES=true con una dirección http: el navegador no guarda la sesión y no se puede iniciar sesión.',
    'Activa HTTPS o pon SECURE_COOKIES=false mientras pruebas.',
  );
  if (prod && flag('ALLOW_PRIVATE_WEBHOOKS', false)) add(
    'warning',
    'security',
    'webhooks.private_allowed',
    ['ALLOW_PRIVATE_WEBHOOKS'],
    'ALLOW_PRIVATE_WEBHOOKS=true desactiva la protección que impide que los webhooks de los clientes lleguen a la red interna del servidor.',
    'Ponlo en false en producción.',
  );

  /* ------------------------------ IA ------------------------------ */
  const aiKey = get('OPENROUTER_API_KEY') || get('OPENAI_API_KEY');
  const aiKeyVar = has('OPENROUTER_API_KEY') ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
  const aiBase = get('OPENROUTER_BASE_URL') || get('OPENAI_BASE_URL') || 'https://openrouter.ai/api/v1';
  const openrouter = host(aiBase) === 'openrouter.ai';
  if (!aiKey) {
    add(
      'warning',
      'ai',
      'ai.key_missing',
      ['OPENROUTER_API_KEY'],
      'Falta la clave de la IA: el panel funciona pero el asistente no puede responder a nadie.',
      'Crea una clave en https://openrouter.ai/keys, ponla en OPENROUTER_API_KEY y ejecuta ./riverrun restart.',
    );
  } else if (openrouter && !aiKey.startsWith('sk-or-')) {
    add(
      'warning',
      'ai',
      'ai.key_format',
      [aiKeyVar, 'OPENROUTER_BASE_URL'],
      'La clave de la IA no tiene el formato de OpenRouter (sk-or-…) pero la dirección es OpenRouter: probablemente es una clave de otro proveedor.',
      'Usa una clave de OpenRouter o cambia OPENROUTER_BASE_URL al proveedor de esa clave.',
    );
  }
  if (HTTP_URL.safeParse(aiBase).success && aiBase.startsWith('http://') && !PRIVATE_HOST.test(host(aiBase))) add(
    'warning',
    'ai',
    'ai.base_insecure',
    ['OPENROUTER_BASE_URL'],
    'La IA se consulta por http sin cifrar: la clave y las conversaciones viajarían en claro.',
    'Usa una dirección https.',
  );
  if (openrouter) {
    for (const k of ['OPENROUTER_MODEL', 'OPENROUTER_SUMMARY_MODEL', 'OPENROUTER_EMBEDDING_MODEL']) {
      const m = get(k);
      if (m && !m.includes('/') && !/^(gpt-|chatgpt-|o\d|text-embedding-)/i.test(m)) add(
        'warning',
        'ai',
        `ai.model.${k}`,
        [k],
        `${k} no tiene la forma proveedor/modelo que usa OpenRouter.`,
        'Copia el nombre exacto de https://openrouter.ai/models (por ejemplo openai/gpt-4.1-mini).',
      );
    }
  }
  const fallbacks = get('OPENROUTER_FALLBACK_MODELS').split(',').map((s) => s.trim()).filter(Boolean);
  if (fallbacks.length > 2) add(
    'warning',
    'ai',
    'ai.fallbacks',
    ['OPENROUTER_FALLBACK_MODELS'],
    'Hay más de 2 modelos de respaldo: OpenRouter solo acepta el principal y 2 de respaldo.',
    'Deja como máximo 2 en OPENROUTER_FALLBACK_MODELS.',
  );
  services.push({ id: 'ai', label: 'IA', area: 'ai', state: aiKey ? 'configured' : 'incomplete', detail: aiKey ? (openrouter ? 'OpenRouter' : `Proveedor compatible (${host(aiBase) || 'dirección inválida'})`) : 'Falta la clave' });

  /* ------------------------------ Búsqueda semántica ------------------------------ */
  const ids = get('KNOWLEDGE_SEARCH_ACCOUNT_IDS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ids.some((id) => !UUID.test(id))) add(
    'critical',
    'knowledge',
    'knowledge.account_ids',
    ['KNOWLEDGE_SEARCH_ACCOUNT_IDS'],
    'KNOWLEDGE_SEARCH_ACCOUNT_IDS debe contener identificadores de cuenta (UUID) separados por comas.',
    'Corrige la lista o déjala vacía.',
  );
  const semantic = flag('KNOWLEDGE_SEARCH_ENABLED', false);
  if (semantic && !aiKey) add(
    'warning',
    'knowledge',
    'knowledge.no_ai',
    ['KNOWLEDGE_SEARCH_ENABLED', 'OPENROUTER_API_KEY'],
    'La búsqueda semántica está activada pero sin clave de IA no se generan embeddings: se usa la búsqueda por palabras.',
    'Agrega OPENROUTER_API_KEY o pon KNOWLEDGE_SEARCH_ENABLED=false.',
  );
  services.push({ id: 'semantic_search', label: 'Búsqueda semántica', area: 'knowledge', state: semantic ? (aiKey ? 'configured' : 'incomplete') : 'disabled', detail: semantic ? (ids.length ? `Piloto: ${ids.length} cuenta(s)` : 'Todas las cuentas') : 'Opcional, apagada' });
  if (!semantic) add(
    'optional',
    'knowledge',
    'knowledge.disabled',
    ['KNOWLEDGE_SEARCH_ENABLED'],
    'Búsqueda semántica apagada: el asistente busca por palabras clave.',
    'Para catálogos grandes: ./riverrun semantic.',
  );

  /* ------------------------------ WhatsApp (Evolution) ------------------------------ */
  const evoUrl = get('EVOLUTION_URL') || 'http://localhost:8080';
  const evoKey = get('EVOLUTION_API_KEY');
  const whatsapp = has('EVOLUTION_URL') || !!evoKey;
  if (whatsapp) {
    if (!evoKey) add(
      'warning',
      'whatsapp',
      'evolution.key_missing',
      ['EVOLUTION_API_KEY'],
      'EVOLUTION_API_KEY está vacía: Evolution rechaza toda petición sin clave, así que WhatsApp no funcionará.',
      'Genera una con `openssl rand -hex 32`, ponla en EVOLUTION_API_KEY (la usan Evolution y el backend) y ejecuta ./riverrun restart.',
    );
    else if (prod && (evoKey.length < 16 || PLACEHOLDER.test(evoKey))) add(
      'warning',
      'security',
      'evolution.key_weak',
      ['EVOLUTION_API_KEY'],
      'EVOLUTION_API_KEY es corta o es la de ejemplo: controla todas las sesiones de WhatsApp.',
      'Reemplázala por `openssl rand -hex 32` y reinicia ambos servicios (./riverrun restart).',
    );
    if (HTTP_URL.safeParse(evoUrl).success && evoUrl.startsWith('http://') && !PRIVATE_HOST.test(host(evoUrl))) add(
      'warning',
      'security',
      'evolution.url_insecure',
      ['EVOLUTION_URL'],
      'Evolution se consulta por http a un servidor externo: la clave y los mensajes viajan sin cifrar.',
      'Usa https o una red privada.',
    );
    const webhookUrl = get('WEBHOOK_BASE_URL') || 'http://localhost:3000';
    if (prod && !has('WEBHOOK_BASE_URL')) add(
      'warning',
      'whatsapp',
      'webhook_url.unset',
      ['WEBHOOK_BASE_URL'],
      'WEBHOOK_BASE_URL no está definido: Evolution enviaría los mensajes entrantes a http://localhost:3000, que dentro de su contenedor no es este backend.',
      'Con Docker usa WEBHOOK_BASE_URL=http://backend:3000 (ya viene en docker-compose.yml).',
    );
    else if (LOCAL_HOST.test(host(webhookUrl)) && !LOCAL_HOST.test(host(evoUrl)) && host(evoUrl)) add(
      'warning',
      'whatsapp',
      'webhook_url.unreachable',
      ['WEBHOOK_BASE_URL', 'EVOLUTION_URL'],
      'Evolution está en otro servidor o contenedor pero WEBHOOK_BASE_URL apunta a localhost: no llegarán los mensajes entrantes.',
      'Pon en WEBHOOK_BASE_URL una dirección del backend a la que Evolution pueda llegar.',
    );
  }
  const image = parseImageRef(get('EVOLUTION_IMAGE'));
  if (image) {
    const v = imageVersion(image);
    if (!isPinned(image)) add(
      'warning',
      'whatsapp',
      'evolution.image_unpinned',
      ['EVOLUTION_IMAGE'],
      'EVOLUTION_IMAGE usa una etiqueta móvil (p. ej. latest): una descarga futura puede cambiar la versión sin aviso y romper sesiones o mensajes.',
      `Bórrala para usar la versión verificada (${EVOLUTION_EXPECTED.version}, fijada por digest) o fija una versión exacta y actualiza con ./riverrun update.`,
    );
    else if (assessVersion(v).status === 'incompatible') add(
      'warning',
      'whatsapp',
      'evolution.image_incompatible',
      ['EVOLUTION_IMAGE'],
      `EVOLUTION_IMAGE declara una versión incompatible con RiverRun (${v}).`,
      `Usa la versión verificada ${EVOLUTION_EXPECTED.version} (bórrala de .env).`,
    );
    else if (assessVersion(v).status !== 'verified') add(
      'warning',
      'whatsapp',
      'evolution.image_unverified',
      ['EVOLUTION_IMAGE'],
      `EVOLUTION_IMAGE fija una versión no verificada con RiverRun (${v ?? 'desconocida'}).`,
      `Pruébala con scripts/evolution-compat.sh antes de usarla en producción, o vuelve a la verificada (${EVOLUTION_EXPECTED.version}).`,
    );
  }
  services.push({
    id: 'whatsapp',
    label: 'WhatsApp (Evolution API)',
    area: 'whatsapp',
    state: !whatsapp ? 'disabled' : evoKey ? 'configured' : 'incomplete',
    detail: !whatsapp ? 'No configurado' : evoKey ? `Imagen ${image ? (isPinned(image) ? 'fijada' : 'no fijada') : `por defecto (${EVOLUTION_EXPECTED.version})`}` : 'Falta EVOLUTION_API_KEY',
  });

  /* ------------------------------ Correo ------------------------------ */
  const smtp = get('SMTP_URL');
  const smtpValid = !smtp || SMTP.safeParse(smtp).success;
  if (!smtpValid) add(
    'warning',
    'email',
    'smtp.invalid',
    ['SMTP_URL'],
    'SMTP_URL no es una dirección smtp:// o smtps:// válida: no saldrá ningún correo.',
    'Ejemplo: smtps://usuario:clave@smtp.tuproveedor.com:465 (si la clave tiene símbolos, codifícala con %XX).',
  );
  const signup = flag('SIGNUP_ENABLED', true);
  const requireEmail = flag('SIGNUP_REQUIRE_EMAIL', true);
  if (!smtp) {
    if (signup && requireEmail) add(
      prod ? 'warning' : 'optional',
      'email',
      'smtp.verification_blocked',
      ['SMTP_URL', 'SIGNUP_REQUIRE_EMAIL'],
      'Sin SMTP_URL no salen correos, pero SIGNUP_REQUIRE_EMAIL=true: nadie podrá confirmar su correo ni conectar canales reales.',
      'Configura SMTP_URL o pon SIGNUP_REQUIRE_EMAIL=false.',
    );
    else add(
      'optional',
      'email',
      'smtp.disabled',
      ['SMTP_URL'],
      'Correo saliente apagado: los correos (avisos, recuperación de contraseña) solo quedan en el registro.',
      'Configura SMTP_URL para enviarlos.',
    );
  } else if (smtpValid && !has('MAIL_FROM')) {
    add(
      'warning',
      'email',
      'mail_from.default',
      ['MAIL_FROM'],
      'MAIL_FROM no está definido: los correos salen como no-responder@localhost y suelen ir a spam o ser rechazados.',
      'Define MAIL_FROM con un remitente de tu dominio, p. ej. "Tu Marca <no-responder@tudominio.com>".',
    );
  }
  if (has('SUPERADMIN_EMAIL') && !EMAIL.safeParse(get('SUPERADMIN_EMAIL').trim()).success) add(
    'warning',
    'monitoring',
    'superadmin_email.invalid',
    ['SUPERADMIN_EMAIL'],
    'SUPERADMIN_EMAIL no es un correo válido: no llegarán las alertas ni los avisos.',
    'Corrígelo.',
  );
  services.push({ id: 'email', label: 'Correo saliente (SMTP)', area: 'email', state: !smtp ? 'disabled' : smtpValid ? 'configured' : 'invalid', detail: !smtp ? 'Opcional, apagado' : smtpValid ? 'Servidor definido' : 'Dirección no válida' });

  /* ------------------------------ Salida de mensajes ------------------------------ */
  // live: envíos reales (producción). sandbox: solo a OUTBOUND_SANDBOX_ALLOW (pruebas y staging).
  const mode = get('OUTBOUND_MODE');
  const sandbox = mode === 'sandbox';
  const modeValid = !has('OUTBOUND_MODE') || ['live', 'sandbox'].includes(mode);
  if (!modeValid) add(
    'critical',
    'core',
    'outbound.invalid',
    ['OUTBOUND_MODE'],
    'OUTBOUND_MODE debe ser live o sandbox: la plataforma no arranca con otro valor, para que un error de escritura no deje envíos reales sin querer.',
    'Usa live (producción) o sandbox (pruebas), o bórrala para live.',
  );
  if (sandbox && prod) add(
    'critical',
    'core',
    'outbound.sandbox_in_production',
    ['OUTBOUND_MODE', 'RIVERRUN_ENV'],
    'Producción con OUTBOUND_MODE=sandbox: ningún mensaje, correo ni cobro saldría a los clientes.',
    'En producción usa OUTBOUND_MODE=live (o bórrala). Si esto es staging, define RIVERRUN_ENV=test.',
  );
  services.push({
    id: 'outbound',
    label: 'Salida de mensajes',
    area: 'core',
    state: modeValid ? 'configured' : 'invalid',
    detail: sandbox ? `Pruebas: ${get('OUTBOUND_SANDBOX_ALLOW').split(',').filter((s) => s.trim()).length} destino(s) permitido(s)` : 'Envíos reales',
  });

  /* ------------------------------ Cobro ------------------------------ */
  const provider = (id: string, label: string, keyVar: string, hookVar: string, keyOk: (s: string) => boolean, testKey: (s: string) => boolean, liveKey: (s: string) => boolean, hookOk: (s: string) => boolean) => {
    const key = get(keyVar);
    const hook = get(hookVar);
    // Crítico aunque falte el aviso de pago: una clave de producción en sandbox nunca debe llegar a usarse.
    if (sandbox && liveKey(key)) add(
      'critical',
      'billing',
      `${id}.live_key_in_sandbox`,
      [keyVar],
      `${label}: este entorno es de pruebas (OUTBOUND_MODE=sandbox) y ${keyVar} es una clave de producción. Con ella se podrían crear cobros o leer facturación real.`,
      `Usa una clave de pruebas de ${label} o quita ${keyVar} de este entorno.`,
    );
    if (!key && !hook) {
      services.push({ id, label, area: 'billing', state: 'disabled', detail: 'Opcional, apagado' });
      return;
    }
    if (!key || !hook) {
      add(
        'warning',
        'billing',
        `${id}.incomplete`,
        [keyVar, hookVar],
        `${label} está a medias: falta ${!key ? keyVar : hookVar}, así que queda desactivado aunque parezca configurado.`,
        `Define ambas (${keyVar} y ${hookVar}) o bórralas.`,
      );
      services.push({ id, label, area: 'billing', state: 'incomplete', detail: `Falta ${!key ? keyVar : hookVar}` });
      return;
    }
    if (!keyOk(key)) add(
      'warning',
      'billing',
      `${id}.key_format`,
      [keyVar],
      `${keyVar} no tiene el formato esperado de ${label}.`,
      `Cópiala de nuevo desde el panel de ${label}.`,
    );
    if (!hookOk(hook)) add(
      'warning',
      'billing',
      `${id}.hook_format`,
      [hookVar],
      `${hookVar} no tiene el formato esperado: las notificaciones de pago serían rechazadas.`,
      `Cópialo del webhook configurado en ${label}.`,
    );
    if (prod && testKey(key)) add(
      'warning',
      'billing',
      `${id}.test_mode`,
      [keyVar],
      `${label} usa una clave de pruebas en producción: no se cobra de verdad.`,
      'Usa la clave de producción.',
    );
    if (!https) add(
      'warning',
      'billing',
      `${id}.needs_https`,
      ['PUBLIC_BASE_URL'],
      `${label} necesita una dirección HTTPS para enviar las notificaciones de pago.`,
      'Activa HTTPS (PUBLIC_BASE_URL=https://…).',
    );
    services.push({ id, label, area: 'billing', state: 'configured', detail: testKey(key) ? 'Modo de pruebas' : 'Claves definidas' });
  };
  provider(
    'stripe',
    'Stripe',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    (s) => /^(sk|rk)_(live|test)_/.test(s),
    (s) => /^(sk|rk)_test_/.test(s),
    (s) => /^(sk|rk)_live_/.test(s),
    (s) => s.startsWith('whsec_'),
  );
  provider(
    'mercadopago',
    'Mercado Pago',
    'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_WEBHOOK_SECRET',
    (s) => /^(APP_USR|TEST)-/.test(s),
    (s) => s.startsWith('TEST-'),
    (s) => s.startsWith('APP_USR-'),
    (s) => s.length >= 16,
  );

  /* ------------------------------ Integraciones ------------------------------ */
  const gid = get('GOOGLE_CLIENT_ID');
  const gsecret = get('GOOGLE_CLIENT_SECRET');
  if (!gid && !gsecret) {
    services.push({ id: 'google', label: 'Google (Calendar e inicio de sesión)', area: 'integrations', state: 'disabled', detail: 'Opcional, apagado' });
  } else if (!gid || !gsecret) {
    add(
      'warning',
      'integrations',
      'google.incomplete',
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      `Google está a medias: falta ${!gid ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET'}, así que Calendar y el inicio de sesión con Google quedan desactivados.`,
      'Define ambas o bórralas (ver docs/integraciones.md).',
    );
    services.push({ id: 'google', label: 'Google (Calendar e inicio de sesión)', area: 'integrations', state: 'incomplete', detail: 'Falta una credencial' });
  } else {
    if (!gid.endsWith('.apps.googleusercontent.com')) add(
      'warning',
      'integrations',
      'google.id_format',
      ['GOOGLE_CLIENT_ID'],
      'GOOGLE_CLIENT_ID no termina en .apps.googleusercontent.com.',
      'Cópialo de Google Cloud → Credenciales.',
    );
    if (prod && !https) add(
      'warning',
      'integrations',
      'google.needs_https',
      ['PUBLIC_BASE_URL'],
      'Google exige una dirección HTTPS para volver al panel después de autorizar.',
      'Activa HTTPS.',
    );
    services.push({ id: 'google', label: 'Google (Calendar e inicio de sesión)', area: 'integrations', state: 'configured', detail: 'Credenciales definidas' });
  }
  const mid = get('MICROSOFT_CLIENT_ID');
  const msecret = get('MICROSOFT_CLIENT_SECRET');
  if (!mid && !msecret) {
    services.push({ id: 'outlook', label: 'Outlook (calendario de Microsoft)', area: 'integrations', state: 'disabled', detail: 'Opcional, apagado' });
  } else if (!mid || !msecret) {
    add(
      'warning',
      'integrations',
      'outlook.incomplete',
      ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
      `Outlook está a medias: falta ${!mid ? 'MICROSOFT_CLIENT_ID' : 'MICROSOFT_CLIENT_SECRET'}, así que no se puede conectar el calendario de Microsoft.`,
      'Define ambas o bórralas (ver docs/integraciones.md).',
    );
    services.push({ id: 'outlook', label: 'Outlook (calendario de Microsoft)', area: 'integrations', state: 'incomplete', detail: 'Falta una credencial' });
  } else {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mid)) add(
      'warning',
      'integrations',
      'outlook.id_format',
      ['MICROSOFT_CLIENT_ID'],
      'MICROSOFT_CLIENT_ID no parece un identificador de aplicación de Microsoft (formato 00000000-0000-0000-0000-000000000000).',
      'Cópialo de Azure → Registros de aplicaciones → «Id. de aplicación (cliente)».',
    );
    if (prod && !https) add(
      'warning',
      'integrations',
      'outlook.needs_https',
      ['PUBLIC_BASE_URL'],
      'Microsoft exige una dirección HTTPS para volver al panel después de autorizar.',
      'Activa HTTPS.',
    );
    services.push({ id: 'outlook', label: 'Outlook (calendario de Microsoft)', area: 'integrations', state: 'configured', detail: 'Credenciales definidas' });
  }

  /* ------------------------------ Monitoreo ------------------------------ */
  for (const k of ['HEARTBEAT_URL', 'ALERT_WEBHOOK_URL']) {
    if (has(k) && !HTTP_URL.safeParse(get(k)).success) add(
      'warning',
      'monitoring',
      `url.${k}`,
      [k],
      `${k} no es una dirección http(s) válida.`,
      `Corrige ${k}.`,
    );
  }
  // ALERT_MUTE: una entrada mal escrita no silencia nada (el aviso sale); una sin fecha no vuelve a avisar sola.
  const mute = parseAlertMute(get('ALERT_MUTE'));
  if (mute.invalid.length) add(
    'warning',
    'monitoring',
    'alert_mute.invalid',
    ['ALERT_MUTE'],
    `ALERT_MUTE tiene ${mute.invalid.length} entrada(s) que no se entienden y no silencian nada.`,
    'Usa componente o componente=AAAA-MM-DDTHH:MM:SSZ.',
  );
  if (mute.forever.length) add(
    'warning',
    'monitoring',
    'alert_mute.forever',
    ['ALERT_MUTE'],
    `ALERT_MUTE silencia sin fecha de fin: ${mute.forever.join(', ')}. No vuelven a avisar solos.`,
    'Pon una fecha de fin: componente=AAAA-MM-DDTHH:MM:SSZ.',
  );
  const alertEmail = has('SUPERADMIN_EMAIL') && !!smtp && smtpValid;
  const alertHook = has('ALERT_WEBHOOK_URL');
  if (prod && !alertEmail && !alertHook) add(
    'warning',
    'monitoring',
    'alerts.none',
    ['SUPERADMIN_EMAIL', 'SMTP_URL', 'ALERT_WEBHOOK_URL'],
    'Nadie recibe las alertas: si algo falla (WhatsApp, respaldos, disco), solo se ve entrando al panel.',
    'Configura SUPERADMIN_EMAIL + SMTP_URL o ALERT_WEBHOOK_URL (Slack, Discord, ntfy…).',
  );
  if (!has('HEARTBEAT_URL')) add(
    'optional',
    'monitoring',
    'heartbeat.disabled',
    ['HEARTBEAT_URL'],
    'Sin latido externo: si el servidor entero cae, nadie se entera.',
    'Configura HEARTBEAT_URL (healthchecks.io es gratis).',
  );
  services.push({ id: 'alerts', label: 'Alertas', area: 'monitoring', state: alertEmail || alertHook ? 'configured' : 'disabled', detail: [alertEmail && 'correo', alertHook && 'webhook', has('HEARTBEAT_URL') && 'latido'].filter(Boolean).join(' + ') || 'Sin canal de aviso' });

  const counts = { critical: 0, warning: 0, optional: 0 } as Record<Level, number>;
  for (const i of issues) counts[i.level]++;
  const order: Record<Level, number> = { critical: 0, warning: 1, optional: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return {
    env: rt,
    mode: get('CONFIG_VALIDATION') === 'warn' ? 'warn' : 'strict',
    checked_at: now.toISOString(),
    status: counts.critical ? 'fail' : counts.warning ? 'warn' : 'ok',
    counts,
    issues,
    services,
  };
}

/** En modo estricto, un problema crítico impide arrancar. CONFIG_VALIDATION=warn lo deja pasar (solo para salir de un apuro). */
export const blocksStartup = (r: ConfigReport) => r.counts.critical > 0 && r.mode === 'strict';

const ENV_LABEL: Record<RuntimeEnv, string> = { production: 'producción', development: 'desarrollo', test: 'pruebas' };
const ICON: Record<Level, string> = { critical: '✕', warning: '!', optional: '·' };

/** Reporte para la consola (sin valores de variables). */
export function formatReport(r: ConfigReport, opts: { optional?: boolean } = {}): string {
  const out = [`Configuración (${ENV_LABEL[r.env]}): ${r.counts.critical} crítico(s), ${r.counts.warning} advertencia(s), ${r.counts.optional} servicio(s) opcional(es) apagado(s).`];
  for (const i of r.issues) {
    if (i.level === 'optional' && !opts.optional) continue;
    out.push(`  ${ICON[i.level]} [${i.level === 'critical' ? 'CRÍTICO' : i.level === 'warning' ? 'AVISO' : 'OPCIONAL'}] ${i.message}`);
    out.push(`      → ${i.fix}`);
  }
  return out.join('\n');
}

let startupReport: ConfigReport | null = null;
/** Reporte del arranque (para el panel: muestra si se arrancó con CONFIG_VALIDATION=warn y problemas críticos). */
export const startupConfigReport = () => startupReport;

/**
 * Se llama antes de cargar el resto del servidor. Devuelve false si el arranque debe detenerse.
 * Imprime el reporte; en producción con problemas críticos y modo estricto, explica cómo corregirlos.
 */
export function checkConfigAtStartup(env: Env = process.env, log: Pick<Console, 'log' | 'warn' | 'error'> = console): boolean {
  const r = validateConfig(env);
  startupReport = r;
  if (r.counts.critical || r.counts.warning) (r.counts.critical ? log.error : log.warn)(formatReport(r));
  if (blocksStartup(r)) {
    log.error(
      [
        '✕ El servidor no arranca: corrige los problemas críticos de arriba en .env y vuelve a iniciar (./riverrun restart).',
        '  Revisión sin arrancar: npm run config:check (o docker compose run --rm --no-deps backend node dist/cli/config-check.js).',
        '  Solo para salir de un apuro: CONFIG_VALIDATION=warn arranca igual y muestra los problemas en el panel (Sistema).',
      ].join('\n'),
    );
    return false;
  }
  if (r.counts.critical) log.error('! CONFIG_VALIDATION=warn: se arranca con problemas críticos. Corrígelos cuanto antes.');
  return true;
}

/** Quita de un texto cualquier valor secreto de la configuración (para mensajes de error de conexiones). */
export function redactSecrets(text: string, env: Env = process.env): string {
  let out = String(text ?? '');
  for (const k of SECRET_VARS) {
    const v = env[k];
    if (v && v.length >= 6) out = out.split(v).join('[oculto]');
  }
  // Credenciales dentro de una URL (smtp://usuario:clave@…, postgres://…).
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[oculto]@');
}
