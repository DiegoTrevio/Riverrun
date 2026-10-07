// Comprueba el panel (módulos ES sin build): sintaxis, que cada import exista como export y que `core.js` no dependa de nada.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = path.resolve(import.meta.dirname, '..', 'public', 'js');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const exportsOf = {};
const src = {};
for (const f of files) {
  src[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  exportsOf[f] = new Set([...src[f].matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z0-9_$]+)/gm)].map((m) => m[1]));
}
const problems = [];
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'pipe' }); } catch (e) { problems.push(`${f}: error de sintaxis\n${e.stderr}`); }
  for (const m of src[f].matchAll(/^import \{([^}]+)\} from '\.\/([\w-]+\.js)';/gm)) {
    if (!exportsOf[m[2]]) { problems.push(`${f}: importa de ${m[2]}, que no existe`); continue; }
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) if (!exportsOf[m[2]].has(name)) problems.push(`${f}: importa ${name} de ${m[2]}, que no lo exporta`);
  }
}
if (/^import /m.test(src['core.js'])) problems.push('core.js no debe importar otros módulos (evita ciclos al arrancar)');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Panel OK: ${files.length} módulos, ${Object.values(src).join('\n').split('\n').length} líneas`);
