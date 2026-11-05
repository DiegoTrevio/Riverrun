// Comprueba el panel (módulos ES sin build): sintaxis, que cada import exista como export y que `core.js` no dependa de nada.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// CHECK_FRONTEND_DIR: otra carpeta (las pruebas del propio chequeo).
const dir = process.env.CHECK_FRONTEND_DIR || path.resolve(import.meta.dirname, '..', 'public', 'js');
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
// Nombres sin declarar o sin importar (el error clásico al editar un módulo): se detectan con el compilador de TypeScript.
try {
  const { default: ts } = await import('typescript');
  const program = ts.createProgram(files.map((f) => path.join(dir, f)), { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], skipLibCheck: true });
  for (const f of files) {
    const sf = program.getSourceFile(path.join(dir, f));
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (![2304, 2552].includes(d.code)) continue; // "Cannot find name 'x'" (+ sugerencia)
      const { line } = sf.getLineAndCharacterOfPosition(d.start);
      problems.push(`${f}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
} catch (e) {
  console.warn('No se pudo ejecutar la revisión de nombres (¿falta typescript?):', e.message);
}
if (/^import /m.test(src['core.js'])) problems.push('core.js no debe importar otros módulos (evita ciclos al arrancar)');
// HTML crudo (IN-20, IN-24): `html:` de h() escribe innerHTML. Solo en los módulos de dibujos fijos (SVG sin datos de nadie);
// todo lo demás arma el DOM con h() y texto. innerHTML/outerHTML/insertAdjacentHTML y demás, solo en core.js (el de h()).

/**
 * Quita los comentarios respetando comillas, plantillas (con sus `${…}`) y expresiones regulares: un `//` dentro de
 * 'https://x' no es un comentario y no debe esconder el resto de la línea. Conserva los saltos de línea.
 */
export function stripComments(code) {
  let i = 0;
  const REGEX_AFTER = /(?:^|[(,=:\[!&|?{};+\-*%<>~^])\s*$|\b(?:return|typeof|case|in|of|delete|void|throw|new|yield|await)\s*$/;
  function scan(inExpr) {
    let out = '';
    let depth = 0;
    while (i < code.length) {
      const ch = code[i];
      const next = code[i + 1];
      if (inExpr && ch === '}' && depth === 0) return out;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (ch === '/' && next === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
      if (ch === '/' && next === '*') {
        const end = code.indexOf('*/', i + 2);
        const stop = end < 0 ? code.length : end + 2;
        out += code.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
        continue;
      }
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < code.length && code[j] !== ch && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
        out += code.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (ch === '`') {
        out += ch;
        i++;
        while (i < code.length && code[i] !== '`') {
          if (code[i] === '\\') { out += code.slice(i, i + 2); i += 2; continue; }
          if (code[i] === '$' && code[i + 1] === '{') { out += '${'; i += 2; out += scan(true); if (code[i] === '}') { out += '}'; i++; } continue; }
          out += code[i++];
        }
        out += '`';
        i++;
        continue;
      }
      if (ch === '/' && REGEX_AFTER.test(out)) {
        let j = i + 1;
        let cls = false;
        while (j < code.length && code[j] !== '\n' && (cls || code[j] !== '/')) {
          if (code[j] === '\\') j++;
          else if (code[j] === '[') cls = true;
          else if (code[j] === ']') cls = false;
          j++;
        }
        out += code.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }
  return scan(false);
}

const HTML_OK = new Set(['icons.js', 'brand.js', 'whatsapp.js']);
const KEY_PATTERNS = [/(?<![\w$.])['"]?html['"]?\s*:/, /\[\s*['"]html['"]\s*\]\s*:/];
const SINK_PATTERNS = [
  [/\.\s*(?:innerHTML|outerHTML)\s*\+?=(?!=)/, 'innerHTML/outerHTML'],
  [/\[\s*['"](?:innerHTML|outerHTML)['"]\s*\]\s*\+?=(?!=)/, 'innerHTML/outerHTML'],
  [/\b(?:innerHTML|outerHTML)['"]?\s*:/, 'innerHTML/outerHTML'],
  [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
  [/\bsetHTMLUnsafe\b/, 'setHTMLUnsafe'],
  [/\bcreateContextualFragment\b/, 'createContextualFragment'],
  [/\bDOMParser\b/, 'DOMParser'],
  [/\bsrcdoc\b/, 'srcdoc'],
];
// Los scripts sueltos de public/ (widget, reservar…) pueden escribir una constante literal; nunca algo armado.
const LITERAL = String.raw`(['"])(?:(?!\1)[^\\\n]|\\.)*\1`;
const LITERAL_WRITES = [new RegExp(String.raw`\.\s*innerHTML\s*=\s*${LITERAL}\s*[;\n]`, 'g'), new RegExp(String.raw`\.insertAdjacentHTML\s*\(\s*(['"])[\w]+\1\s*,\s*(['"])(?:(?!\2)[^\\\n]|\\.)*\2\s*\)`, 'g')];
function rawHtmlProblems(name, text, { panel }) {
  let code = stripComments(text);
  if (!panel) for (const re of LITERAL_WRITES) code = code.replace(re, '');
  const out = [];
  if (!HTML_OK.has(name) && KEY_PATTERNS.some((re) => re.test(code))) out.push(`${name}: usa html: (HTML crudo); arma el contenido con h() o pásalo como texto`);
  if (name !== 'core.js') {
    const found = [...new Set(SINK_PATTERNS.filter(([re]) => re.test(code)).map(([, label]) => label))];
    if (found.length) out.push(`${name}: escribe HTML crudo (${found.join(', ')})`);
  }
  return out;
}
for (const f of files) problems.push(...rawHtmlProblems(f, src[f], { panel: true }));
// Los demás .js de public/ (widget.js, reservar.js, api-docs.js, app.js…), cuando el panel está en public/js.
if (path.basename(dir) === 'js') {
  const root = path.dirname(dir);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (p === dir ? [] : walk(p)) : e.name.endsWith('.js') ? [p] : [];
  });
  for (const p of walk(root)) problems.push(...rawHtmlProblems(path.relative(root, p), fs.readFileSync(p, 'utf8'), { panel: false }));
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Panel OK: ${files.length} módulos, ${Object.values(src).join('\n').split('\n').length} líneas`);
