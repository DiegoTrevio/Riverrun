/**
 * Diagnóstico de servicios para el panel de Sistema (solo superadmin). Distingue cinco niveles, porque una
 * variable presente o una respuesta HTTP no bastan para decir que algo funciona:
 *   configurado → accesible → credenciales válidas → funcional → listo para usarse.
 * `null` en un nivel = no verificado (no se pudo o no se intenta). Ninguna comprobación gasta saldo ni envía
 * mensajes: la IA se valida con consultas gratuitas, el correo con `verify()` (sin enviar) y Evolution solo con
 * lecturas. Los mensajes de error pasan por redactSecrets: nunca incluyen claves ni contraseñas.
 */
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import { missingModels } from './ai/models.js';
import { config } from './config.js';
import { blocksStartup, redactSecrets, startupConfigReport, validateConfig } from './config-check.js';
import { migrationsDir, query, queryOne } from './db.js';
import { deepCheck, evolutionSnapshot, probeService } from './evolution/status.js';

export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'na';
export interface Probe {
  id: string;
  label: string;
  configured: boolean;
  reachable: boolean | null;
  credentials: boolean | null;
  functional: boolean | null;
  ready: boolean | null;
  status: ProbeStatus;
  detail: string;
  checked_at: string;
}

const TIMEOUT_MS = 8000;
const clean = (e: any) => redactSecrets(String(e?.code ?? e?.cause?.code ?? e?.message ?? e)).slice(0, 200);
const probe = (id: string, label: string, p: Partial<Probe>): Probe => ({
  id, label, configured: true, reachable: null, credentials: null, functional: null, ready: null, status: 'na', detail: '', checked_at: new Date().toISOString(), ...p,
});

async function probeDatabase(): Promise<Probe> {
  const label = 'Base de datos (PostgreSQL)';
  try {
    await queryOne('SELECT 1');
  } catch (e: any) {
    // 28P01/28000: la base respondió pero rechazó el usuario o la clave; 3D000: la base no existe.
    const auth = e?.code === '28P01' || e?.code === '28000';
    const answered = auth || e?.code === '3D000';
    return probe('database', label, { reachable: answered, credentials: auth ? false : null, functional: false, ready: false, status: 'fail', detail: clean(e) });
  }
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const pending = files.filter((f) => !applied.has(f));
  return probe('database', label, {
    reachable: true, credentials: true, functional: true, ready: !pending.length,
    status: pending.length ? 'fail' : 'ok',
    detail: pending.length ? `Migraciones sin aplicar: ${pending.join(', ')}` : `Responde; ${files.length} migraciones aplicadas`,
  });
}

/** IA: OpenRouter tiene /key (gratis: valida la clave y el saldo); otros proveedores compatibles, /models con la clave. */
async function probeAi(): Promise<Probe> {
  const label = 'IA (asistente)';
  const { apiKey, baseUrl, defaultModel } = config.openai;
  if (!apiKey) return probe('ai', label, { configured: false, ready: false, status: 'fail', detail: 'Falta OPENROUTER_API_KEY: el asistente no puede responder' });
  const openrouter = new URL(baseUrl).hostname === 'openrouter.ai';
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/${openrouter ? 'key' : 'models'}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return probe('ai', label, { reachable: false, ready: false, status: 'fail', detail: `No responde: ${clean(e)}` });
  }
  if (res.status === 401 || res.status === 403) return probe('ai', label, { reachable: true, credentials: false, functional: false, ready: false, status: 'fail', detail: `El proveedor rechaza la clave (HTTP ${res.status})` });
  if (!res.ok) return probe('ai', label, { reachable: true, status: 'warn', detail: `Respuesta inesperada al validar la clave (HTTP ${res.status})` });
  let detail = openrouter ? 'Clave válida (OpenRouter)' : 'Clave válida';
  let functional: boolean | null = true;
  if (openrouter) {
    // Solo se usa el saldo restante: la respuesta incluye una etiqueta con parte de la clave que nunca se muestra.
    const data: any = await res.json().catch(() => null);
    const remaining = data?.data?.limit_remaining;
    if (typeof remaining === 'number' && remaining <= 0) {
      functional = false;
      detail = 'Clave válida pero sin saldo: el asistente dejará de responder';
    }
    const missing = await missingModels().catch(() => null);
    if (missing === null) detail += '; catálogo de modelos no consultado';
    else if (missing.some((m) => m.id === defaultModel || m.id === `openai/${defaultModel}`)) {
      functional = false;
      detail = `El modelo principal (${defaultModel}) no existe en OpenRouter`;
    } else if (missing.length) detail += `; ${missing.length} modelo(s) configurado(s) no existen (ver "Modelos de IA")`;
  }
  return probe('ai', label, { reachable: true, credentials: true, functional, ready: functional === true, status: functional ? 'ok' : 'fail', detail });
}

async function probeWhatsapp(): Promise<Probe> {
  const label = 'WhatsApp (Evolution API)';
  if (!config.evolution.apiKey) return probe('whatsapp', label, { configured: false, ready: false, status: 'fail', detail: 'Falta EVOLUTION_API_KEY' });
  const s = await probeService({ force: true });
  if (!s.reachable) return probe('whatsapp', label, { reachable: false, ready: false, status: 'fail', detail: `No responde: ${s.error ?? ''}` });
  if (s.auth === false) return probe('whatsapp', label, { reachable: true, credentials: false, functional: false, ready: false, status: 'fail', detail: 'Evolution rechaza EVOLUTION_API_KEY' });
  if (s.auth === null) return probe('whatsapp', label, { reachable: true, functional: false, ready: false, status: 'fail', detail: `Responde pero no atiende la API: ${s.error ?? ''}` });
  const deep = await deepCheck().catch(() => null);
  const compatible = s.assessment.status === 'verified' ? true : s.assessment.status === 'incompatible' ? false : null;
  const sessions = deep ? (deep.summary.total ? deep.summary.open > 0 && !deep.summary.missing : null) : null;
  const ready = compatible === false || sessions === false ? false : compatible && sessions ? true : null;
  const parts = [`Versión ${s.version ?? 'no verificada'} (${s.assessment.label})`];
  if (deep) parts.push(deep.summary.total ? `${deep.summary.open}/${deep.summary.total} sesiones abiertas` : 'sin canales de WhatsApp');
  if (deep?.summary.missing) parts.push(`${deep.summary.missing} instancia(s) vinculada(s) perdida(s)`);
  if (deep?.summary.webhook_problems) parts.push(`${deep.summary.webhook_problems} webhook(s) incorrecto(s)`);
  const status: ProbeStatus = compatible === false || deep?.summary.missing ? 'fail' : compatible && !deep?.summary.webhook_problems && sessions !== false ? 'ok' : 'warn';
  return probe('whatsapp', label, { reachable: true, credentials: s.auth, functional: compatible, ready, status, detail: parts.join(' · ') });
}

/** SMTP: se conecta y se autentica sin enviar nada. */
async function probeEmail(): Promise<Probe> {
  const label = 'Correo saliente (SMTP)';
  if (!config.mail.smtpUrl) return probe('email', label, { configured: false, status: 'na', detail: 'Opcional, apagado: los correos solo quedan en el registro' });
  let t;
  try {
    t = nodemailer.createTransport(config.mail.smtpUrl, { connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS } as any);
    await t.verify();
    const from = /@localhost>?$/.test(config.mail.from);
    return probe('email', label, { reachable: true, credentials: true, functional: true, ready: !from, status: from ? 'warn' : 'ok', detail: from ? 'Autentica, pero MAIL_FROM es de localhost (suele ir a spam)' : 'Se conecta y autentica (no se envió ningún correo)' });
  } catch (e: any) {
    const auth = e?.code === 'EAUTH';
    return probe('email', label, { reachable: auth ? true : e?.code === 'ECONNECTION' || e?.code === 'ETIMEDOUT' || e?.code === 'EDNS' ? false : null, credentials: auth ? false : null, functional: false, ready: false, status: 'fail', detail: auth ? 'El servidor rechaza el usuario o la clave' : clean(e) });
  } finally {
    t?.close();
  }
}

/** Servicios cuyas credenciales no se prueban (se verifican al usarse): se informa como "no verificado". */
function unverified(): Probe[] {
  const out: Probe[] = [];
  const add = (id: string, label: string, on: boolean, detail: string) => out.push(probe(id, label, { configured: on, status: 'na', detail: on ? `${detail} Credenciales no verificadas automáticamente (se validan al usarse).` : 'Opcional, apagado' }));
  add('stripe', 'Cobro con Stripe', !!(config.billing.stripe.secretKey && config.billing.stripe.webhookSecret), 'Claves definidas.');
  add('mercadopago', 'Cobro con Mercado Pago', !!(config.billing.mercadopago.accessToken && config.billing.mercadopago.webhookSecret), 'Claves definidas.');
  add('google', 'Google (Calendar e inicio de sesión)', !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), 'Credenciales definidas.');
  return out;
}

let last: { checked_at: string; probes: Probe[] } | null = null;
let running: Promise<{ checked_at: string; probes: Probe[] }> | null = null;
const MIN_INTERVAL_MS = 30_000;

/** Corre todas las comprobaciones (una a la vez; como máximo una cada 30 s si se piden desde el panel). */
export async function refreshDiagnostics(opts: { force?: boolean } = {}) {
  if (running) return running;
  if (!opts.force && last && Date.now() - new Date(last.checked_at).getTime() < MIN_INTERVAL_MS) return last;
  running = (async () => {
    const probes = await Promise.all([probeDatabase(), probeAi(), probeWhatsapp(), probeEmail()].map((p) => p.catch((e) => probe('error', 'Comprobación', { status: 'fail', detail: clean(e) }))));
    last = { checked_at: new Date().toISOString(), probes: [...probes, ...unverified()] };
    await query(`INSERT INTO system_state (key, value, updated_at) VALUES ('diagnostics', $1, now()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [last]).catch(() => undefined);
    return last;
  })().finally(() => {
    running = null;
  });
  return running;
}

export function resetDiagnostics() {
  last = null;
}

/** Todo lo que muestra la sección de configuración del panel. */
export async function diagnosticsReport() {
  if (!last) {
    const row = await queryOne<{ value: typeof last }>(`SELECT value FROM system_state WHERE key = 'diagnostics'`).catch(() => null);
    last = row?.value ?? null;
  }
  const report = validateConfig(process.env);
  const startup = startupConfigReport();
  return {
    config: report,
    // Arrancó con CONFIG_VALIDATION=warn y problemas críticos: el panel lo muestra en rojo.
    started_with_critical: !!startup && startup.counts.critical > 0 && !blocksStartup(startup),
    connectivity: last,
    evolution: await evolutionSnapshot(),
  };
}
