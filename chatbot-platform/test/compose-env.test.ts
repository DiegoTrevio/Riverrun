/**
 * Cada variable que lee la app llega al contenedor (docker-compose.yml no tiene env_file: las pasa una por una) y está
 * documentada en .env.example. Una variable nueva que se olvide en compose rompe esta prueba, no la producción.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

/** Lo que no se pasa a propósito: direcciones que solo cambian las pruebas, nombres viejos y lo que fija la imagen. */
const NOT_IN_COMPOSE = new Set([
  'NODE_ENV', 'HOST', 'PORT',
  'META_GRAPH_URL', 'META_DIALOG_URL', 'TELEGRAM_API_URL', 'ZERNIO_API_URL', 'TURNSTILE_VERIFY_URL',
  'STRIPE_API_URL', 'MERCADOPAGO_API_URL', 'FACTURAPI_API_URL', 'GOOGLE_OAUTH_URL', 'GOOGLE_AUTH_URL', 'GOOGLE_API_URL',
  'MICROSOFT_LOGIN_URL', 'MICROSOFT_GRAPH_URL',
]);
/** Nombres viejos de OpenAI: compose los usa solo como valor por defecto de su equivalente OPENROUTER_*. */
const legacy = (name: string) => name.startsWith('OPENAI_');
/** Internas del contenedor (las fija compose) o solo de diagnóstico: no hace falta documentarlas en .env.example. */
const NOT_IN_EXAMPLE = new Set([...NOT_IN_COMPOSE, 'APP_VERSION', 'BACKUP_DIR', 'UPLOADS_DIR', 'DATABASE_URL', 'WEBHOOK_BASE_URL', 'EVOLUTION_URL', 'EVOLUTION_IMAGE', 'HTTP_LOG', 'LOG_DEBUG']);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Variables que lee el servidor: env('X') en config.ts y process.env.X en el resto (sin los comandos de consola). */
function appVars() {
  const names = new Set<string>();
  for (const file of walk(path.join(root, 'src'))) {
    if (file.includes(`${path.sep}cli${path.sep}`)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\benv\('([A-Z][A-Z0-9_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/process\.env(?:\.|\[')([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return names;
}

/** Nombres del bloque environment: del servicio backend. */
function composeBackendVars() {
  const lines = read('docker-compose.yml').split('\n');
  const start = lines.indexOf('  backend:');
  assert.ok(start >= 0, 'docker-compose.yml no tiene el servicio backend');
  const names = new Set<string>();
  let inEnv = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // siguiente servicio
    if (/^ {4}[^\s#]/.test(line)) { inEnv = line.trim() === 'environment:'; continue; }
    const m = inEnv && /^ {6}([A-Z][A-Z0-9_]+):/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

test('docker-compose.yml le pasa al backend todas las variables que lee la app', () => {
  const compose = composeBackendVars();
  const missing = [...appVars()].filter((v) => !NOT_IN_COMPOSE.has(v) && !legacy(v) && !compose.has(v)).sort();
  assert.deepEqual(missing, [], `Agrega a docker-compose.yml (backend → environment) como \${VAR:-}: ${missing.join(', ')}`);
});

test('.env.example documenta todas las variables que lee la app (aunque sea comentadas)', () => {
  const example = read('.env.example');
  const missing = [...appVars()].filter((v) => !NOT_IN_EXAMPLE.has(v) && !legacy(v) && !new RegExp(`^#?\\s*${v}=`, 'm').test(example)).sort();
  assert.deepEqual(missing, [], `Documenta en .env.example: ${missing.join(', ')}`);
});

test('la clave que firma las sesiones es obligatoria en compose y Caddy espera al backend sano', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /SESSION_SECRET: \$\{SESSION_SECRET:\?/);
  assert.match(compose, /backend: \{ condition: service_healthy \}/, 'Caddy espera al backend sano');
});
