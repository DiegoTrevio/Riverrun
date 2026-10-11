/**
 * Versiones de Evolution API conocidas por RiverRun: cuál se espera, cuáles se verificaron y qué migraciones de
 * esquema trae cada una. Módulo puro (sin config ni base de datos): lo usan el validador de configuración,
 * el monitoreo y `./riverrun update` (vía dist/cli/evolution-check.js).
 *
 * Para cambiar de versión: correr scripts/evolution-compat.sh contra la imagen nueva, agregarla aquí con su digest
 * y su última migración (prisma/postgresql-migrations del repositorio oficial) y actualizar docker-compose.yml.
 */

export const EVOLUTION_REPOSITORY = 'evoapicloud/evolution-api';

export type KnownStatus = 'verified' | 'untested' | 'incompatible';

export interface KnownVersion {
  version: string;
  /** Digest del índice multiarquitectura publicado en Docker Hub. */
  digest?: string;
  status: KnownStatus;
  /** Última migración de PostgreSQL que aplica al arrancar (Evolution corre `prisma migrate deploy` en cada inicio). */
  lastMigration: string;
  notes: string;
}

/** Imagen fijada por defecto en docker-compose.yml (etiqueta legible + digest inmutable). */
export const EVOLUTION_EXPECTED = {
  version: '2.3.7',
  image: `${EVOLUTION_REPOSITORY}:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`,
} as const;

export const KNOWN_VERSIONS: KnownVersion[] = [
  {
    version: '2.3.7',
    digest: 'sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339',
    status: 'verified',
    lastMigration: '20251122003044_add_chat_instance_remotejid_unique',
    notes:
      'Verificada con scripts/evolution-compat.sh (API real, sin teléfono). Su migración borra chats duplicados y crea un índice único: no se puede volver a 2.3.6 o anterior sin restaurar el respaldo.',
  },
  {
    version: '2.3.6',
    digest: 'sha256:93a836e788fa07d3057f13eafee342f365ae5653035ef811b28c188f4ddadb5e',
    status: 'untested',
    lastMigration: '20250918182355_add_kafka_integration',
    notes: 'Misma API que 2.3.7 según el código fuente; no verificada con la suite. Se usa como origen en la prueba de actualización.',
  },
  {
    version: '2.3.0',
    status: 'untested',
    lastMigration: '20250613143000_add_lid_column_to_is_onwhatsapp',
    notes: 'Primera 2.3 (identificadores @lid). Las versiones 2.3.0 a 2.3.3 comparten esta migración; 2.3.4 y 2.3.5 la de 2.3.6.',
  },
  {
    version: '2.2.3',
    status: 'untested',
    lastMigration: '20250116001415_add_wavoip_token_to_settings_table',
    notes: 'Anterior a los identificadores @lid: los números pueden llegar incompletos.',
  },
  {
    // Solo la RC que se probó: el servidor la informa como "2.4.0" (sin sufijo), por eso se identifica por digest.
    version: '2.4.0-rc2',
    digest: 'sha256:b4a18ed5213d34a0845f841ba9afae1b67940457d021b42af863eae67dc2cfbd',
    status: 'incompatible',
    lastMigration: '20260506184850_add_runtime_config',
    notes:
      'Probada con la imagen real: exige activar una licencia de Evolution Foundation; hasta registrarla, toda la API responde 503 LICENSE_REQUIRED y WhatsApp deja de funcionar (GET / sigue diciendo "it is working"). Agrega 2 migraciones irreversibles (token de instancia más largo y tabla RuntimeConfig).',
  },
];

export type Compatibility = 'verified' | 'unverified' | 'incompatible' | 'unknown';

export interface Assessment {
  status: Compatibility;
  /** Texto corto para el panel. */
  label: string;
  detail: string;
}

const LABELS: Record<Compatibility, string> = {
  verified: 'Compatible (verificada)',
  unverified: 'No verificada',
  incompatible: 'Incompatible',
  unknown: 'No verificada',
};

const assessment = (status: Compatibility, detail: string): Assessment => ({ status, label: LABELS[status], detail });

/** "v2.3.7" → [2,3,7]; null si no parece una versión. */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function normalizeVersion(v: string | null | undefined): string | null {
  const p = parseVersion(v);
  if (!p) return null;
  const pre = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/.exec(String(v).trim())?.[1] ?? '';
  return `${p.join('.')}${pre}`;
}

/** Coincidencia exacta: "2.4.0" (lo que informa el servidor) y "2.4.0-rc2" (etiqueta de la imagen) son versiones distintas. */
export const knownVersion = (v: string | null | undefined) => {
  const n = normalizeVersion(v);
  return n ? KNOWN_VERSIONS.find((k) => k.version === n) ?? null : null;
};

/** Compatibilidad de una versión detectada (o declarada) con el cliente de RiverRun. */
export function assessVersion(version: string | null | undefined): Assessment {
  const v = normalizeVersion(version);
  if (!v) return assessment('unknown', 'Evolution no informó su versión: no se puede confirmar la compatibilidad.');
  const [major, minor] = parseVersion(v)!;
  if (major !== 2) return assessment('incompatible', `Evolution ${v}: RiverRun usa la API v2 (rutas /instance, /message y /webhook de la versión 2).`);
  if (minor < 2) return assessment('incompatible', `Evolution ${v} es anterior a 2.2: le faltan funciones que RiverRun usa (vinculación por número y medios recibidos).`);
  const known = knownVersion(v);
  if (known?.status === 'incompatible') return assessment('incompatible', `Evolution ${v}: ${known.notes}`);
  if (known?.status === 'verified') return assessment('verified', `Evolution ${v} pasó la suite de compatibilidad de RiverRun.`);
  // 2.4 y posteriores: la RC probada exige licencia. Sin probar la versión concreta no se da por buena, pero tampoco se
  // bloquea a ciegas: si el servidor responde LICENSE_REQUIRED, el monitoreo la marca como fallo (status.ts → blocked).
  if (minor >= 4) return assessment('unverified', `Evolution ${v} no está verificada. La 2.4.0-rc2 probada exige licencia (503 LICENSE_REQUIRED): antes de usarla, verifícala con scripts/evolution-compat.sh.`);
  if (v.includes('-')) return assessment('unverified', `Evolution ${v} es una versión preliminar: no se recomienda en producción.`);
  return assessment('unverified', `Evolution ${v} no está verificada con RiverRun (la verificada es ${EVOLUTION_EXPECTED.version}).${known ? ` ${known.notes}` : ''}`);
}

export interface ImageRef {
  raw: string;
  repository: string;
  tag: string | null;
  digest: string | null;
}

/** "repo:tag@sha256:…" → partes. Acepta registros con puerto ("registro:5000/repo:tag"). */
export function parseImageRef(raw: string | null | undefined): ImageRef | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const [name, digest] = s.split('@');
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  const hasTag = colon > slash;
  return { raw: s, repository: hasTag ? name.slice(0, colon) : name, tag: hasTag ? name.slice(colon + 1) : null, digest: digest || null };
}

/** Fijada = digest inmutable o una etiqueta de versión exacta (no "latest", "homolog", "develop"…). */
export function isPinned(ref: ImageRef | null): boolean {
  if (!ref) return false;
  if (ref.digest && /^sha256:[0-9a-f]{64}$/.test(ref.digest)) return true;
  return !!ref.tag && !!parseVersion(ref.tag);
}

/** Versión que declara una imagen: por su digest (si es conocido) o por su etiqueta. */
export function imageVersion(ref: ImageRef | null): string | null {
  if (!ref) return null;
  const byDigest = ref.digest ? KNOWN_VERSIONS.find((k) => k.digest === ref.digest) : undefined;
  if (byDigest) return byDigest.version;
  return normalizeVersion(ref.tag);
}

export interface UpgradePlan {
  /** 0 = sin riesgo de esquema; 3 = requiere confirmación; 4 = bloqueado. */
  code: 0 | 3 | 4;
  target: { image: string; version: string | null; assessment: Assessment; pinned: boolean };
  schema: 'none' | 'fresh' | 'forward' | 'downgrade' | 'unknown';
  lines: string[];
}

/**
 * Plan para cambiar la imagen de Evolution: compatibilidad de la versión destino y efecto sobre el esquema.
 * `dbMigration` es la última migración aplicada en la base `evolution`: vacía o "-" si todavía no tiene esquema,
 * "?" si no se pudo leer (se trata como desconocido: requiere confirmación).
 */
export function planUpgrade(targetImage: string, dbMigration: string): UpgradePlan {
  const ref = parseImageRef(targetImage);
  const version = imageVersion(ref);
  const a = assessVersion(version);
  const known = knownVersion(version);
  const lines: string[] = [];
  const pinned = isPinned(ref);
  lines.push(`Destino: ${targetImage} → versión ${version ?? 'desconocida'} (${a.label})`);
  lines.push(version ? a.detail : 'La etiqueta de la imagen no indica la versión: no se puede confirmar la compatibilidad antes de arrancarla.');
  if (!pinned) lines.push('La imagen destino no está fijada (usa una etiqueta móvil): la versión puede cambiar sin aviso.');
  let schema: UpgradePlan['schema'] = 'unknown';
  if (dbMigration === '?') {
    lines.push('No se pudo leer el esquema actual de la base de Evolution: no se sabe si la versión destino lo migrará.');
  } else if (!dbMigration || dbMigration === '-') {
    schema = 'fresh';
    lines.push('La base de Evolution está vacía: no hay datos que migrar.');
  } else if (!known) {
    lines.push(`Última migración aplicada: ${dbMigration}. No se sabe qué migraciones trae la versión destino: puede cambiar el esquema de forma irreversible.`);
  } else if (known.lastMigration === dbMigration) {
    schema = 'none';
    lines.push('El esquema de la base de Evolution no cambia: volver a la imagen anterior es seguro si algo falla.');
  } else if (known.lastMigration > dbMigration) {
    schema = 'forward';
    lines.push(`Aplicará migraciones de esquema (de ${dbMigration} a ${known.lastMigration}). Son irreversibles: si algo falla, volver atrás exige restaurar el respaldo previo.`);
  } else {
    schema = 'downgrade';
    lines.push(`La base ya fue migrada por una versión más nueva (${dbMigration}); la versión destino solo conoce hasta ${known.lastMigration}. Bajar de versión puede dañar los datos.`);
  }
  if (known?.notes && !a.detail.includes(known.notes)) lines.push(known.notes);
  const code: UpgradePlan['code'] = a.status === 'incompatible' || schema === 'downgrade' ? 4 : schema === 'none' || schema === 'fresh' ? (a.status === 'verified' && pinned ? 0 : 3) : 3;
  return { code, target: { image: targetImage, version, assessment: a, pinned }, schema, lines };
}
