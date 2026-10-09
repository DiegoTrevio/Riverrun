/**
 * Catálogo de modelos de OpenRouter: avisa cuando un modelo configurado (global, de respaldo o de algún asistente)
 * ya no existe, antes de que los clientes se queden sin respuestas. El catálogo es público (no requiere clave).
 */
import { config } from '../config.js';
import { query } from '../db.js';

let cache: { at: number; ids: Set<string> } | null = null;
const TTL_MS = 6 * 3600_000;

export function resetModelCatalogCache() {
  cache = null;
}

export async function fetchCatalog(now = Date.now(), baseUrl = config.openai.baseUrl): Promise<Set<string> | null> {
  if (cache && now - cache.at < TTL_MS) return cache.ids;
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return cache?.ids ?? null;
    const data: any = await res.json();
    const ids = new Set<string>((data.data ?? []).map((m: any) => String(m.id)));
    if (!ids.size) return cache?.ids ?? null;
    cache = { at: now, ids };
    return ids;
  } catch {
    return cache?.ids ?? null;
  }
}

/** Modelos que la plataforma usa hoy, con dónde se configuran. */
export async function configuredModels(): Promise<{ id: string; where: string }[]> {
  const o = config.openai;
  const list: { id: string; where: string }[] = [
    { id: o.defaultModel, where: 'OPENROUTER_MODEL' },
    { id: o.summaryModel, where: 'OPENROUTER_SUMMARY_MODEL' },
    { id: o.transcriptionModel, where: 'OPENROUTER_TRANSCRIPTION_MODEL' },
    ...o.fallbackModels.map((id) => ({ id, where: 'OPENROUTER_FALLBACK_MODELS' })),
  ];
  const rows = await query<{ name: string; model: string; fallbacks: string[] }>(
    `SELECT name, ai->>'model' AS model, COALESCE(ARRAY(SELECT jsonb_array_elements_text(ai->'fallback_models')), '{}') AS fallbacks FROM chatbots`,
  ).catch(() => []);
  for (const r of rows) {
    if (r.model) list.push({ id: r.model, where: `asistente "${r.name}"` });
    for (const f of r.fallbacks) list.push({ id: f, where: `respaldo de "${r.name}"` });
  }
  // En OpenRouter los modelos llevan "proveedor/nombre"; un nombre suelto se normaliza como lo hace el cliente.
  return list.filter((m) => m.id).map((m) => ({ ...m, id: !m.id.includes('/') && /^(gpt-|chatgpt-|o\d)/i.test(m.id) ? `openai/${m.id}` : m.id }));
}

/** Modelos configurados que el catálogo de OpenRouter no conoce. `null` si no se pudo consultar. */
export async function missingModels(catalogOverride?: Set<string>): Promise<{ id: string; where: string }[] | null> {
  if (!catalogOverride && new URL(config.openai.baseUrl).hostname !== 'openrouter.ai') return null;
  const catalog = catalogOverride ?? (await fetchCatalog());
  if (!catalog) return null;
  const seen = new Set<string>();
  const missing: { id: string; where: string }[] = [];
  for (const m of await configuredModels()) {
    // Variantes como ":nitro" o ":free" se validan por su base.
    const base = m.id.split(':')[0];
    if (catalog.has(m.id) || catalog.has(base) || seen.has(m.id)) continue;
    seen.add(m.id);
    missing.push(m);
  }
  return missing;
}
