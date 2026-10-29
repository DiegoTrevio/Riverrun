/**
 * Registro de herramientas del Copiloto. Cada herramienta declara su esquema (de ahí sale el JSON Schema que ve el
 * modelo), quién la puede usar, su riesgo según los argumentos, la vista previa que se muestra al confirmar y cómo se
 * ejecuta (siempre por las rutas del panel, con `ctx.call`).
 */
import { z } from 'zod';
import type { ToolSpec } from '../ai/provider.js';
import type { User } from '../types.js';
import type { Caller } from './executor.js';
import type { Link, Page, Preview, UndoRecipe } from './store.js';

export type Area = 'cuenta' | 'agente' | 'automatizacion' | 'contactos' | 'conversaciones' | 'agenda' | 'oportunidades' | 'cobros' | 'cotizaciones' | 'datos';
export type Level = 'read' | 'reversible' | 'confirm';
export interface RiskInfo { level: Level; reasons: string[] }
export interface Target { kind: string; id: string }

/** Lo que tiene a mano una herramienta mientras corre. */
export interface Ctx {
  user: User;
  accountId: string;
  timezone: string;
  call: Caller;
  page: Page;
  threadId: string;
  turnId: string;
  /** Registros que este turno puede cambiar sin confirmación aunque haya leído texto de clientes. */
  scope: Set<string>;
  tainted: boolean;
  /** Al confirmar: la propuesta que la persona vio (su `meta` dice cómo estaba el registro entonces). */
  proposal?: Preview;
}

export interface ExecResult {
  /** Lo que vuelve al modelo (se recorta antes de mandarlo). */
  data: unknown;
  /** Qué pasó, en una frase («Etiqueté a Ana López como VIP»). */
  title?: string;
  links?: Link[];
  before?: unknown;
  after?: unknown;
  undo?: UndoRecipe | null;
  /** Contactos que tocó (privacidad y alcance). */
  contactIds?: string[];
  /** La respuesta trae texto escrito por clientes. */
  untrusted?: boolean;
  /** Registros que leyó (el alcance de lo que se puede cambiar después). */
  read?: Target[];
  /** Lo que muestra la tarjeta de lo hecho (p. ej. el antes y el después de unas instrucciones). */
  preview?: Preview;
}

export interface ToolDef<A = any> {
  name: string;
  area: Area;
  /** Roles que la pueden usar (el superadmin puede lo que el administrador). */
  roles: ('admin' | 'agent')[];
  description: string;
  schema: z.ZodType<A>;
  /** Esquema más corto para el modelo cuando el completo repite el de otra herramienta (el servidor valida con `schema`). */
  modelSchema?: z.ZodType;
  /** Texto del paso mientras corre («Buscando contactos…»). */
  label: (args: A) => string;
  risk: (args: A, ctx: Ctx) => Level | RiskInfo | Promise<Level | RiskInfo>;
  /** Vista previa armada por el servidor: la tarjeta de confirmación y el título de la acción. */
  preview?: (args: A, ctx: Ctx) => Preview | Promise<Preview>;
  /** Registros que cambia (para el alcance cuando el turno leyó texto de clientes). */
  targets?: (args: A, ctx: Ctx) => Target[] | Promise<Target[]>;
  /** Eventos de automatización que dispara el cambio (para saber si una regla mandará mensajes). */
  events?: (args: A, ctx: Ctx) => TriggerHint[] | Promise<TriggerHint[]>;
  execute: (args: A, ctx: Ctx) => Promise<ExecResult>;
  /** Deshacer especial (cuando no basta con repetir pasos guardados). */
  undo?: (params: any, ctx: Ctx) => Promise<void>;
  /** Disponible solo si se cumple (p. ej. cobros activados). */
  available?: () => boolean;
}

/** Un evento que dispararía un cambio: el tipo de disparador de las reglas y su valor (etiqueta, campo, etapa…). */
export interface TriggerHint { type: string; value?: string }

export function defineTool<A>(t: ToolDef<A>): ToolDef<A> {
  return t;
}

export function riskInfo(r: Level | RiskInfo): RiskInfo {
  return typeof r === 'string' ? { level: r, reasons: [] } : r;
}

/** ¿Puede este usuario usar la herramienta? */
export function allowed(def: ToolDef, user: User): boolean {
  if (def.available && !def.available()) return false;
  if (user.role === 'superadmin' || user.role === 'admin') return def.roles.includes('admin');
  return def.roles.includes('agent');
}

/** Palabras del JSON Schema cuyo valor es un mapa de nombre → esquema: sus claves son nombres de campos, no palabras. */
const MAPS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);

/**
 * JSON Schema limpio y corto para el modelo (va en cada paso de cada pedido): sin `$schema`, sin el regex largo de los
 * uuid, sin topes de enteros enormes, sin valores por omisión adentro (los pone zod al validar; los de los argumentos de
 * arriba sí van, porque dicen qué pasa si el modelo no los manda, como «avisar al cliente»), sin `type` junto a un `const`
 * y sin `additionalProperties` adentro (zod quita los campos de más; solo el objeto de arriba lo dice).
 */
function clean(node: any): any {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'default') continue;
    if (k === 'pattern' && node.format === 'uuid') continue;
    if (k === 'type' && node.const !== undefined) continue;
    if (k === 'additionalProperties' && (v === false || (v && typeof v === 'object' && !Object.keys(v).length))) continue;
    if ((k === 'maximum' && v === Number.MAX_SAFE_INTEGER) || (k === 'minimum' && v === Number.MIN_SAFE_INTEGER)) continue;
    out[k] = MAPS.has(k) && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, clean(s)])) : clean(v);
  }
  return out;
}

export function toolSpec(def: ToolDef): ToolSpec {
  const full: any = z.toJSONSchema(def.modelSchema ?? def.schema, { target: 'draft-7', io: 'input' });
  const schema = clean(full);
  for (const [k, v] of Object.entries<any>(full.properties ?? {})) if (v && 'default' in v) schema.properties[k].default = v.default;
  if (schema.additionalProperties === undefined) schema.additionalProperties = false;
  return { name: def.name, description: def.description, parameters: schema };
}
