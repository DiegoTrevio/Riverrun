/**
 * Qué herramientas ve el modelo en cada pedido: el núcleo y los paquetes que hacen falta. Un paquete se carga por la
 * página abierta, porque ya se usó en la conversación (sus llamadas se repiten en el historial y el proveedor necesita la
 * herramienta), porque se cargó en el pedido anterior o porque el modelo lo pide con `usar_herramientas`.
 */
import { config } from '../config.js';
import { PACKS, PACK_IDS, packOf, type Pack, type ToolDef } from './registry.js';
import type { Page } from './store.js';

/** Paquete de la página abierta (por su área; el núcleo siempre va). */
export function pagePack(page: Page | undefined): Pack | null {
  const area = page?.area;
  return area && (PACK_IDS as string[]).includes(area) ? (area as Pack) : null;
}

/** Las herramientas a mandar: primero el núcleo, después cada paquete en el orden de `PACKS` (estable para la caché). */
export function visibleTools(all: ToolDef[], packs: Set<Pack>): ToolDef[] {
  if (!config.copilot.toolPacks) return all;
  const out: ToolDef[] = [];
  for (const p of PACK_IDS) {
    if (p !== 'base' && !packs.has(p)) continue;
    for (const def of all) if (packOf(def) === p) out.push(def);
  }
  return out;
}

/** Paquetes de este pedido: núcleo + página + los de las herramientas que se repiten en el historial + los del pedido anterior. */
export function activePacks(o: { all: ToolDef[]; page?: Page; replayed?: Iterable<string>; previous?: Iterable<string> }): Set<Pack> {
  const packs = new Set<Pack>(['base']);
  const page = pagePack(o.page);
  if (page) packs.add(page);
  const byName = new Map(o.all.map((d) => [d.name, packOf(d)]));
  for (const name of o.replayed ?? []) {
    const p = byName.get(name);
    if (p) packs.add(p);
  }
  for (const p of o.previous ?? []) if ((PACK_IDS as string[]).includes(p)) packs.add(p as Pack);
  return packs;
}

/** Índice de paquetes para las instrucciones (fijo por rol): qué hay en cada uno, para pedirlo con `usar_herramientas`. */
export function packIndex(all: ToolDef[]): string {
  const lines = PACKS.filter((p) => p.id !== 'base').map((p) => {
    const names = all.filter((d) => packOf(d) === p.id).map((d) => d.name);
    return names.length ? `- ${p.id}: ${p.resumen} (${names.join(', ')})` : '';
  }).filter(Boolean);
  if (!lines.length) return '';
  return `Herramientas por área. Siempre tienes las de base; las de otra área las cargas con usar_herramientas (o, si llamas una herramienta de la lista, se carga sola):\n${lines.join('\n')}`;
}
