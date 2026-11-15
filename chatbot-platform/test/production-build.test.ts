/**
 * La imagen de producción no reparte el código legible: el panel va comprimido (scripts/minify-public.mjs, corrido en el
 * Dockerfile) y ni el panel ni el backend llevan mapas de código (source maps). Además, el panel nunca contiene llaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
// @ts-expect-error: módulo .mjs sin tipos
import { minifyDir } from '../scripts/minify-public.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

function filesIn(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesIn(p, ext) : ext.test(e.name) ? [p] : [];
  });
}

/** Copia de public/ comprimida, como queda en la imagen. */
async function minifiedCopy(): Promise<{ dir: string; before: number; after: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riverrun-public-'));
  fs.cpSync(path.join(root, 'public'), dir, { recursive: true });
  const { before, after } = await minifyDir(dir);
  return { dir, before, after };
}

test('el panel comprimido pesa menos, no trae mapas de código y cada archivo sigue siendo JavaScript válido', async () => {
  const { dir, before, after } = await minifiedCopy();
  try {
    assert.ok(after < before * 0.85, `debería bajar al menos 15 % (antes ${before} B, después ${after} B)`);
    const files = filesIn(dir, /\.(js|css)$/);
    assert.ok(files.length > 20);
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(code, /sourceMappingURL/, `${path.relative(dir, f)} enlaza un mapa de código`);
      if (f.endsWith('.js')) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    }
    assert.deepEqual(filesIn(dir, /\.map$/), [], 'no debe quedar ningún archivo .map');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el panel comprimido conserva cada import y export entre módulos', async () => {
  const { dir } = await minifiedCopy();
  try {
    // Juntar cada módulo con sus dependencias falla si un import pide un nombre que el otro módulo ya no exporta.
    const entryPoints = [path.join(dir, 'app.js'), ...filesIn(path.join(dir, 'js'), /\.js$/)];
    const r = await build({ entryPoints, bundle: true, write: false, format: 'esm', outdir: path.join(dir, 'out'), logLevel: 'silent' });
    assert.deepEqual(r.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('la imagen comprime el panel y el backend se compila sin mapas de código', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /node scripts\/minify-public\.mjs public/);
  assert.match(docker, /COPY --from=build \/app\/public \.\/public/, 'la imagen final debe copiar el panel ya comprimido');
  const final = docker.slice(docker.lastIndexOf('\nFROM '));
  assert.doesNotMatch(final, /^COPY public /m, 'la etapa final no debe copiar el panel legible del repo');
  assert.equal(JSON.parse(read('tsconfig.json')).compilerOptions.sourceMap, false);
});

test('el panel no contiene llaves ni contraseñas', () => {
  const secret = [
    /sk-(?:or-|proj-|ant-)?[A-Za-z0-9_-]{20,}/, // OpenAI, OpenRouter, Anthropic
    /sk_live_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/, // Stripe
    /AKIA[0-9A-Z]{16}/, // AWS / Spaces
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, // Resend
    /postgres(?:ql)?:\/\/[^\s'"`:]+:[^\s'"`@]+@/, // cadena de conexión con contraseña
  ];
  for (const f of filesIn(path.join(root, 'public'), /\.(js|css|html)$/)) {
    const code = fs.readFileSync(f, 'utf8');
    for (const re of secret) assert.doesNotMatch(code, re, `${path.relative(root, f)} parece contener una llave (${re})`);
  }
});

test('Caddy comprime las respuestas con zstd y gzip', () => {
  const caddy = read('docker/Caddyfile');
  const encodes = [...caddy.matchAll(/^\s*encode (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(encodes.length >= 2);
  for (const e of encodes) assert.equal(e, 'zstd gzip');
});
