// Comprime el panel (public/) para la imagen de producción: quita espacios y comentarios y acorta los nombres internos de
// cada archivo .js y .css. Cada archivo se procesa por separado (sin juntar módulos): los imports entre módulos y los
// nombres que se exportan no cambian, así que el panel funciona igual. No genera mapas de código (source maps).
//
// Uso: node scripts/minify-public.mjs <carpeta>   (reescribe los archivos en su lugar; en el repo nunca se corre sobre
// public/, solo dentro del Dockerfile sobre la copia de la imagen).
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';

/** Navegadores que el panel ya exige (módulos ES, `?.`, `??`): no se reescribe sintaxis moderna. */
const TARGET = 'es2022';

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return filesIn(p);
    return /\.(js|css)$/.test(e.name) ? [p] : [];
  });
}

export async function minifyDir(dir) {
  let before = 0;
  let after = 0;
  for (const file of filesIn(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    const loader = file.endsWith('.css') ? 'css' : 'js';
    // `legalComments: 'none'` quita también los comentarios /*! … */; `sourcemap: false` es lo predeterminado y se deja
    // explícito para que nadie lo active sin querer.
    const out = await transform(src, { loader, minify: true, target: TARGET, legalComments: 'none', sourcemap: false, charset: 'utf8' });
    fs.writeFileSync(file, out.code);
    before += Buffer.byteLength(src);
    after += Buffer.byteLength(out.code);
  }
  return { before, after };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) {
    console.error('Uso: node scripts/minify-public.mjs <carpeta>');
    process.exit(1);
  }
  const { before, after } = await minifyDir(dir);
  console.log(`Panel comprimido: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
}
