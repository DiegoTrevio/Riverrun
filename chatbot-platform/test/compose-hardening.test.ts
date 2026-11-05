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
 * DAC_OVERRIDE y FOWNER para preparar el directorio de datos y leer volúmenes de otros dueños. Redis corre como root (su command
 * esquiva el entrypoint oficial) y ./riverrun restore deja /data a nombre de «redis»: necesita CHOWN, DAC_OVERRIDE y FOWNER. Caddy solo abre los puertos 80 y 443.
 */
const ADD: Record<string, string[]> = {
  postgres: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'], redis: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
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

/**
 * INF-17: toda imagen va por digest (`etiqueta@sha256:…`), para que una etiqueta movida en Docker Hub no llegue a un servidor
 * sin pasar por el CI. Las que vienen de una variable llevan el digest en su valor por omisión. Dependabot las actualiza.
 */
test('toda imagen va por digest', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const refs: Array<{ where: string; ref: string }> = [];
  for (const m of compose.matchAll(/^\s*image:\s*(\S+)/gm)) refs.push({ where: 'docker-compose.yml', ref: m[1] });
  for (const m of compose.matchAll(/^x-[\w-]+-image:\s*&\S+\s+(\S+)/gm)) refs.push({ where: 'docker-compose.yml (ancla)', ref: m[1] });
  for (const file of ['Dockerfile', 'docker/backup/Dockerfile']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const stages = new Set([...text.matchAll(/^FROM\s+.*\s+AS\s+(\S+)\s*$/gim)].map((m) => m[1]));
    for (const m of text.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)/gm)) if (!stages.has(m[1])) refs.push({ where: file, ref: m[1] });
    // Dependabot solo lee las líneas FROM: una imagen escrita en COPY --from se quedaría con su digest viejo para siempre.
    for (const m of text.matchAll(/^COPY\s+--from=(\S+)/gm)) assert.ok(stages.has(m[1]), `${file}: COPY --from=${m[1]} debe copiar de una etapa con nombre (FROM <imagen>@sha256:… AS <nombre>), no de una imagen`);
  }
  assert.ok(refs.length >= 10, `se esperaban al menos 10 imágenes y hay ${refs.length}`);
  for (const { where, ref } of refs) {
    if (ref.startsWith('*')) continue; // alias de YAML: la ancla ya se revisa
    assert.match(ref, /@sha256:[0-9a-f]{64}\}?$/, `${where}: ${ref} no va por digest`);
  }
});

test('npm ci del Dockerfile no corre scripts de instalación', () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'Dockerfile'), 'utf8');
  const calls = text.match(/npm ci[^\n&]*/g) ?? [];
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.match(c, /--ignore-scripts/, c);
});
