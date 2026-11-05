/**
 * INF-16: cada contenedor corre con lo mínimo: no-new-privileges, sin capacidades de Linux salvo las que de verdad usa,
 * y con el sistema de archivos de solo lectura donde se puede. Lee docker-compose.yml como texto, por bloque de servicio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const compose = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'docker-compose.yml'), 'utf8');

/** El bloque de un servicio: desde «  nombre:» hasta el siguiente servicio (o la sección de redes). */
function block(svc: string): string {
  const m = compose.match(new RegExp(`^  ${svc}:\\n([\\s\\S]*?)(?=^  \\w[\\w-]*:\\n|^\\S)`, 'm'));
  assert.ok(m, `servicio ${svc} no encontrado`);
  return m[1];
}

/** Las capacidades de cap_add (en una línea con corchetes), ordenadas. */
function capAdd(b: string): string[] {
  const m = b.match(/cap_add:\s*\[([^\]]*)\]/);
  return m ? m[1].split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean).sort() : [];
}

/**
 * Postgres, el respaldo y la restauración arrancan como root y se bajan a su usuario (gosu): SETUID/SETGID, y CHOWN,
 * DAC_OVERRIDE y FOWNER para preparar el directorio de datos y leer volúmenes de otros dueños. Redis solo cambia el dueño
 * de /data y baja de usuario. Caddy solo abre los puertos 80 y 443.
 */
const ADD: Record<string, string[]> = {
  postgres: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'], redis: ['CHOWN', 'SETGID', 'SETUID'],
  caddy: ['NET_BIND_SERVICE'], backup: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'], restore: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
  backend: [], evolution: [], pdf: [],
};
for (const [svc, caps] of Object.entries(ADD)) test(`${svc}: no-new-privileges, cap_drop ALL y solo sus capacidades`, () => {
  const b = block(svc);
  assert.match(b, /security_opt:\s*\[\s*"no-new-privileges:true"\s*\]/);
  assert.match(b, /cap_drop:\s*\[\s*ALL\s*\]/);
  assert.deepEqual(capAdd(b), caps);
});

test('backend, caddy y redis con sistema de archivos de solo lectura y tmpfs', () => {
  for (const s of ['backend', 'caddy', 'redis']) assert.match(block(s), /read_only:\s*true[\s\S]*tmpfs:/, s);
});

test('caddy guarda certificados (/data) y configuración (/config) en volúmenes, no en el sistema de solo lectura', () => {
  const b = block('caddy');
  assert.match(b, /caddy_data:\/data/);
  assert.match(b, /caddy_config:\/config/);
  assert.match(compose, /^volumes:[\s\S]*^  caddy_config:/m);
});
