/**
 * Estado real de Evolution API, por niveles: responde (servicio) → acepta la llave (credenciales) → versión
 * compatible (funcional) → sesiones conectadas y con el webhook correcto (lista para usarse).
 *
 * Solo hace consultas de lectura con tiempo límite: nunca crea, borra, desconecta ni recrea instancias.
 * La versión se pide como máximo cada 10 minutos (en Evolution, la raíz consulta además la versión de WhatsApp Web).
 */
import { webhookUrl } from '../channels/index.js';
import { config } from '../config.js';
import { redactSecrets } from '../config-check.js';
import { query, queryOne } from '../db.js';
import { logEvent } from '../logs.js';
import type { Channel } from '../types.js';
import { EvolutionClient, WEBHOOK_EVENTS } from './client.js';
import { EVOLUTION_EXPECTED, assessVersion, imageVersion, isPinned, normalizeVersion, parseImageRef, type Assessment } from './compat.js';

const PROBE_TIMEOUT_MS = 5000;
const VERSION_TTL_MS = 10 * 60_000;
/** Ventana tras un cambio de versión en la que las desconexiones se tratan como posible efecto de la actualización. */
export const postUpdateWindowMs = () => config.whatsappAlerts.postUpdateHours * 3600_000;
const STATE_KEY = 'evolution';

export interface EvolutionService {
  reachable: boolean;
  /** null = no se pudo comprobar (Evolution no respondió o respondió con error). */
  auth: boolean | null;
  /** Evolution responde pero se niega a atender la API (2.4: licencia sin activar). */
  blocked: 'license' | null;
  version: string | null;
  assessment: Assessment;
  error: string | null;
  checked_at: string;
}

export interface InstanceCheck {
  channel_id: string;
  channel: string;
  instance: string;
  /** open · connecting · close · not_found · error · custom_server (servidor propio del canal, no se revisa) */
  state: string;
  webhook: 'ok' | 'missing' | 'mismatch' | 'disabled' | 'unknown';
  /** Ya estuvo vinculada a un teléfono: si desaparece, se perdió una sesión. */
  linked: boolean;
}

export interface DeepCheck {
  checked_at: string;
  instances: InstanceCheck[];
  summary: { total: number; open: number; connecting: number; closed: number; missing: number; webhook_problems: number; errors: number; custom_server: number };
}

interface Persisted {
  version: string | null;
  previous_version: string | null;
  changed_at: string | null;
  seen_at: string;
  deep?: DeepCheck['summary'] & { checked_at: string };
}

const client = () => new EvolutionClient(config.evolution.url, config.evolution.apiKey, PROBE_TIMEOUT_MS);
const errText = (e: any) => redactSecrets(String(e?.cause?.code ?? e?.message ?? e)).slice(0, 200);

let versionCache: { at: number; version: string | null } | null = null;
let serviceCache: EvolutionService | null = null;
let deepCache: DeepCheck | null = null;

export function resetEvolutionStatusCache() {
  versionCache = null;
  serviceCache = null;
  deepCache = null;
}

async function loadState(): Promise<Persisted | null> {
  const row = await queryOne<{ value: Persisted }>(`SELECT value FROM system_state WHERE key = $1`, [STATE_KEY]).catch(() => null);
  return row?.value ?? null;
}

async function saveState(value: Persisted) {
  await query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [STATE_KEY, value]).catch(() => undefined);
}

/** Guarda la versión vista; si cambió, lo registra (una vez) para vigilar los errores posteriores a la actualización. */
async function recordVersion(version: string | null, now = new Date()) {
  if (!version) return;
  const prev = await loadState();
  if (prev?.version === version) {
    await saveState({ ...prev, seen_at: now.toISOString() });
    return;
  }
  const changed = !!prev?.version;
  await saveState({ ...(prev ?? {}), version, previous_version: changed ? prev!.version : prev?.previous_version ?? null, changed_at: changed ? now.toISOString() : prev?.changed_at ?? null, seen_at: now.toISOString() });
  if (changed) await logEvent({ level: 'warn', source: 'evolution', message: `Evolution cambió de versión: ${prev!.version} → ${version}. Se vigilan desconexiones y fallos de entrega durante 24 h.` });
}

/** Servicio: responde, acepta la llave y versión (cacheada). `force` vuelve a pedir la versión. */
export async function probeService(opts: { force?: boolean; now?: number } = {}): Promise<EvolutionService> {
  const now = opts.now ?? Date.now();
  const evo = client();
  const out: EvolutionService = { reachable: false, auth: null, blocked: null, version: null, assessment: assessVersion(null), error: null, checked_at: new Date(now).toISOString() };
  try {
    out.auth = await evo.checkApiKey();
    out.reachable = true;
  } catch (e: any) {
    // Cualquier respuesta HTTP indica que el servicio está vivo, aunque la consulta falle.
    out.reachable = typeof e?.status === 'number';
    out.error = errText(e);
    if (e?.body?.code === 'LICENSE_REQUIRED') {
      out.blocked = 'license';
      out.error = 'Evolution exige activar una licencia (LICENSE_REQUIRED) y no atiende la API: WhatsApp no funciona';
    }
  }
  if (out.reachable) {
    if (!opts.force && versionCache && now - versionCache.at < VERSION_TTL_MS) out.version = versionCache.version;
    else {
      try {
        out.version = (await evo.serverInfo()).version;
      } catch {
        out.version = null;
      }
      versionCache = { at: now, version: out.version };
      await recordVersion(out.version);
    }
  } else if (versionCache) {
    out.version = versionCache.version; // última conocida (se aclara en el panel que no responde)
  }
  out.assessment = assessVersion(out.version);
  serviceCache = out;
  return out;
}

const sameServer = (ch: Pick<Channel, 'config'>) => {
  const url = String(ch.config?.url ?? '').replace(/\/$/, '');
  return !url || url === config.evolution.url;
};

/** Revisa cada canal de WhatsApp activo: estado de la sesión y webhook. Lectura pura. */
export async function deepCheck(now = new Date()): Promise<DeepCheck> {
  const channels = await query<Channel>(`SELECT * FROM channels WHERE type = 'whatsapp' AND active ORDER BY created_at LIMIT 300`);
  const evo = client();
  const results: InstanceCheck[] = [];
  const queue = channels.filter((c) => c.config?.instance);
  const worker = async () => {
    for (let ch = queue.shift(); ch; ch = queue.shift()) {
      const linked = !!ch.config.number || ch.connection_state === 'open' || ch.connection_state === 'close';
      const base = { channel_id: ch.id, channel: ch.name, instance: String(ch.config.instance), linked };
      if (!sameServer(ch)) {
        results.push({ ...base, state: 'custom_server', webhook: 'unknown' });
        continue;
      }
      let state = 'error';
      try {
        state = await evo.connectionState(ch.config.instance);
      } catch (e: any) {
        state = e?.status === 404 ? 'not_found' : 'error';
      }
      let webhook: InstanceCheck['webhook'] = 'unknown';
      if (state !== 'not_found' && state !== 'error') {
        try {
          const w = await evo.findWebhook(ch.config.instance);
          const needed = WEBHOOK_EVENTS.filter((e) => e !== 'QRCODE_UPDATED');
          if (!w) webhook = 'missing';
          else if (!w.enabled) webhook = 'disabled';
          else if (w.url !== webhookUrl(ch) || (w.events.length && !needed.every((e) => w.events.includes(e)))) webhook = 'mismatch';
          else webhook = 'ok';
        } catch {
          webhook = 'unknown';
        }
      }
      results.push({ ...base, state, webhook });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const count = (f: (i: InstanceCheck) => boolean) => results.filter(f).length;
  const deep: DeepCheck = {
    checked_at: now.toISOString(),
    instances: results,
    summary: {
      total: results.length,
      open: count((i) => i.state === 'open'),
      connecting: count((i) => i.state === 'connecting'),
      closed: count((i) => i.state === 'close'),
      // Una instancia que nunca se vinculó se crea al conectar: que no exista todavía no es un problema.
      missing: count((i) => i.state === 'not_found' && i.linked),
      webhook_problems: count((i) => ['missing', 'mismatch', 'disabled'].includes(i.webhook)),
      errors: count((i) => i.state === 'error'),
      custom_server: count((i) => i.state === 'custom_server'),
    },
  };
  deepCache = deep;
  const st = await loadState();
  if (st) await saveState({ ...st, deep: { ...deep.summary, checked_at: deep.checked_at } });
  return deep;
}

export const lastDeepCheck = () => deepCache;
export const lastService = () => serviceCache;

/** Cambio de versión reciente (para vincular desconexiones o fallos con una actualización). */
export async function recentVersionChange(now = Date.now()): Promise<{ from: string | null; to: string; at: string } | null> {
  const st = await loadState();
  if (!st?.changed_at || !st.version) return null;
  return now - new Date(st.changed_at).getTime() < postUpdateWindowMs() ? { from: st.previous_version, to: st.version, at: st.changed_at } : null;
}

/**
 * Antes de que la vinculación recree por su cuenta una instancia trabada: si ya estuvo vinculada y Evolution acaba de
 * cambiar de versión o no es compatible, recrearla borraría una sesión que quizá se recupera corrigiendo la versión.
 */
export async function recreateBlockedReason(ch: Pick<Channel, 'config' | 'connection_state'>): Promise<string | null> {
  const linked = !!ch.config?.number || ch.connection_state === 'open' || ch.connection_state === 'close';
  if (!linked) return null;
  // Evolution que no atiende la API (p. ej. licencia sin activar) o una versión incompatible: no se borra nada.
  if (serviceCache?.blocked) return 'Evolution no atiende la API (requiere licencia)';
  if (serviceCache?.assessment.status === 'incompatible') return 'La versión de Evolution no es compatible';
  const change = await recentVersionChange();
  return change ? `Evolution cambió de versión hace menos de 24 h (${change.from ?? '?'} → ${change.to})` : null;
}

/** Resumen para el panel de Sistema (sin secretos). */
export async function evolutionSnapshot() {
  const image = parseImageRef(config.evolution.image);
  const st = await loadState();
  const svc = serviceCache;
  return {
    expected: { version: EVOLUTION_EXPECTED.version, image: EVOLUTION_EXPECTED.image },
    configured_image: config.evolution.image || null,
    configured_version: imageVersion(image),
    pinned: image ? isPinned(image) : null,
    // Con una comprobación reciente, lo que respondió Evolution (aunque no informe versión); si no, lo último guardado.
    detected_version: svc ? svc.version : st?.version ?? null,
    compatibility: svc ? svc.assessment : assessVersion(st?.version ?? null),
    reachable: svc?.reachable ?? null,
    auth: svc?.auth ?? null,
    error: svc?.error ?? null,
    last_checked_at: svc?.checked_at ?? st?.seen_at ?? null,
    version_change: st?.changed_at ? { from: st.previous_version, to: st.version, at: st.changed_at } : null,
    sessions: deepCache ? { ...deepCache.summary, checked_at: deepCache.checked_at } : st?.deep ?? null,
    problems: (deepCache?.instances ?? []).filter((i) => i.state === 'not_found' ? i.linked : i.state === 'error' || ['missing', 'mismatch', 'disabled'].includes(i.webhook)).slice(0, 20),
  };
}

/**
 * Resultado de una verificación después de cambiar Evolution (lo usa `evolution-check verify` en ./riverrun update).
 * Falla si no atiende la API, rechaza la llave, es incompatible, perdió instancias vinculadas o no volvió ninguna de
 * las sesiones que estaban abiertas; avisa si la versión no está verificada o no es la configurada.
 */
export function assessAfterChange(s: EvolutionService, deep: DeepCheck | null, previousOpen: string[], configuredVersion: string | null) {
  const fail: string[] = [];
  const warn: string[] = [];
  if (!s.reachable) fail.push(`Evolution no responde (${s.error ?? 'sin respuesta'})`);
  else if (s.auth === false) fail.push('Evolution rechaza EVOLUTION_API_KEY');
  else if (s.auth === null) fail.push(`Evolution responde pero no atiende la API: ${s.error ?? 'error desconocido'}`);
  if (s.reachable && s.assessment.status === 'incompatible') fail.push(s.assessment.detail);
  else if (s.reachable && s.assessment.status !== 'verified') warn.push(`Versión ${s.version ?? 'no verificada'}: ${s.assessment.detail}`);
  // Las versiones preliminares informan la versión sin sufijo (2.4.0-rc2 responde 2.4.0): se comparan sin él.
  const base = (v: string | null) => normalizeVersion(v)?.replace(/-.*$/, '') ?? null;
  if (s.reachable && s.version && configuredVersion && base(s.version) !== base(configuredVersion)) warn.push(`Responde la versión ${s.version} pero la configurada es ${configuredVersion}: ¿se recreó el contenedor de Evolution?`);
  if (deep) {
    const byInstance = new Map(deep.instances.map((i) => [i.instance, i]));
    const lost = previousOpen.filter((n) => byInstance.get(n)?.state === 'not_found');
    const back = previousOpen.filter((n) => byInstance.get(n)?.state === 'open');
    if (lost.length) fail.push(`Instancias que estaban conectadas y ya no existen en Evolution: ${lost.join(', ')}`);
    if (previousOpen.length && !back.length) fail.push(`Ninguna de las ${previousOpen.length} sesiones que estaban abiertas volvió a conectarse`);
    else if (back.length < previousOpen.length - lost.length) warn.push(`Sesiones que aún no vuelven: ${previousOpen.filter((n) => !back.includes(n) && !lost.includes(n)).join(', ')}`);
    if (deep.summary.missing && !lost.length) warn.push(`${deep.summary.missing} instancia(s) vinculada(s) no existen en Evolution`);
    if (deep.summary.webhook_problems) warn.push(`${deep.summary.webhook_problems} canal(es) con el webhook ausente o distinto`);
  }
  return { status: fail.length ? 'fail' : warn.length ? 'warn' : 'ok', fail, warn } as const;
}
