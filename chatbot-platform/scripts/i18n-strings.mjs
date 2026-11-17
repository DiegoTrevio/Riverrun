// Textos del panel que ven las personas y su traducción al inglés (public/i18n/en.json).
// Lee cada módulo de public/js con el compilador de TypeScript y junta los textos en español: los fijos ('Guardar') y
// los que llevan partes que cambian (`${n} días` → «{0} días»). Sin argumentos revisa que todos tengan traducción y
// termina con error si falta alguno; con --missing imprime los que faltan (con dónde aparecen) en JSON.
// Lo que parece texto pero no se ve en la pantalla (nombres internos, selectores) va en scripts/i18n-ignore.json.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const SKIP_PROPS = new Set(['class','style','href','src','type','id','role','for','autocomplete','inputmode','pattern','method','accept','rel','target','download','key','kind','icon','tag','route','path','url','mode','status','variant','tone','width','height','viewBox','d','fill','stroke','x','y','cx','cy','r','points','transform','min','max','step','lang','dir','enterkeyhint','loading','decoding','sizes','srcset','media','as','crossorigin','integrity','spellcheck','wrap','list','form','headers','scope','colspan','rowspan','tabindex','hidden','data','field','event','action','channel','provider','plan','unit','format','sort','order','filter','color','background','font']);
const SKIP_CALLS = new Set(['h','svg','querySelector','querySelectorAll','closest','api','addEventListener','removeEventListener','getElementById','createElement','add','remove','toggle','contains','setAttribute','getAttribute','removeAttribute','hasAttribute','matches','import','getItem','setItem','removeItem','startsWith','endsWith','includes','split','replace','replaceAll','match','test','indexOf','padStart','join','dispatchEvent','CustomEvent','postMessage','fetch','URL','URLSearchParams','RegExp','icon','go','navigate','scrollTo','toLocaleString','toLocaleDateString','toLocaleTimeString','DateTimeFormat','NumberFormat','Intl','localeCompare','get','has','set','delete','requestApi','apiForm','emit','on','off','recordUX','track','poll','setProperty','getPropertyValue','insertAdjacentHTML','sessionStorage','localStorage','log','debug']);
const isText = (s) => {
  const t = s.replace(/\{\{[^}]*\}\}/g, 'x').replace(/\{\d+\}/g, '').trim();
  if (t.length < 2 || !/[A-Za-zÁÉÍÓÚáéíóúñÑ¿¡]/.test(t)) return false;
  if (/^(\/|https?:|#|\.[a-z]|data:|mailto:|tel:|wa\.me)/.test(t)) return false;
  const code = t.replace(/\{\{[^}]*\}\}/g, '');
  if ((/[{}<>]|;\S|=>|\(\)/.test(code) || /\S=\S/.test(code)) && !/[¿¡áéíóúñ]/.test(t)) return false;
  if (/^[a-z0-9_\-.:\/]+$/.test(t)) return /[áéíóúñ]/.test(t) || false; // identifiers, slugs, lowercase single words
  if (/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)+$/.test(t) && !/[áéíóúñ]/.test(t) && /-/.test(t)) return false; // css lists
  if (/^[A-Z_0-9]+$/.test(t)) return false;
  if (/^(SELECT|UPDATE|INSERT|DELETE|WITH)\s/.test(t)) return false; // SQL
  if (!/\s/.test(s.trim()) && /[=?&]/.test(s)) return false; // pedazos de una URL (?plan={0})
  return true;
};
function skipCtx(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertyAssignment(p) && p.initializer === node) { const n = p.name.text ?? p.name.getText(); if (SKIP_PROPS.has(n)) return true; }
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isElementAccessExpression(p)) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    const e = p.expression; const n = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
    if (SKIP_CALLS.has(n)) return true;
  }
  if (ts.isCallExpression(p) && p.arguments.includes(node)) {
    const e = p.expression; const n = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
    if (['api','replace','replaceAll','setItem','setProperty','padStart'].includes(n)) return true;
  }
  if (ts.isNewExpression(p)) return true;
  if (ts.isTaggedTemplateExpression(p)) return true;
  return false;
}
// Flatten + concatenation into a pattern
function concatParts(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...concatParts(node.left), ...concatParts(node.right)];
  if (ts.isParenthesizedExpression(node)) return concatParts(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ lit: node.text }];
  if (ts.isTemplateExpression(node)) { const r = [{ lit: node.head.text }]; for (const sp of node.templateSpans) { r.push({ expr: sp.expression }); r.push({ lit: sp.literal.text }); } return r; }
  return [{ expr: node }];
}
function pattern(parts) { let i = 0, s = ''; for (const p of parts) { if ('lit' in p) s += p.lit; else s += `{${i++}}`; } return s; }
/** Textos de los archivos dados: Map de llave normalizada → lugares (archivo:línea). */
export function extractStrings(files) {
  const out = new Map();
  const add = (s, f, line) => {
    const k = normalizeKey(s);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(`${f}:${line}`);
  };
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const fname = f.replace(/^.*?public\//, '');
    const visit = (node) => {
      const line = () => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        const parts = concatParts(node);
        if (parts.some((p) => 'lit' in p) && parts.some((p) => 'expr' in p) && !skipCtx(node)) { const pt = pattern(parts); if (isText(pt)) add(pt, fname, line()); }
        for (const p of parts) if ('expr' in p) visit(p.expr);
        return;
      }
      if (ts.isTemplateExpression(node)) {
        if (!skipCtx(node)) { const parts = concatParts(node); const pt = pattern(parts); if (isText(pt)) add(pt, fname, line()); }
        node.templateSpans.forEach((sp) => visit(sp.expression));
        return;
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !skipCtx(node) && isText(node.text)) add(node.text, fname, line());
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Mensajes del servidor que el panel muestra tal cual (errores y avisos de la API): el texto de `new HttpError(…)`,
 * de `notFound(…)`/`assertAccount(…)` y los `error:`/`message:` de las rutas. El panel los traduce al mostrarlos.
 */
const PANEL_PROPS = new Set(['title', 'body', 'label', 'description', 'detail', 'hint', 'fix', 'help', 'summary_text']);
const PANEL_FILES = ['config-check.ts', 'monitor.ts', 'observability/health.ts', 'observability/status.ts', 'automation/alert-groups.ts', 'onboarding-checklist.ts', 'integrations/webhooks.ts'].map((f) => f.split('/').join(path.sep));

const MODEL_PATHS = ['copilot/', 'engine/', 'routes/openapi.ts', 'templates/agent-builder.ts', 'quotes/from-text.ts', 'cli/'].map((f) => f.split('/').join(path.sep));

export function serverStrings(srcDir = path.resolve(here, '..', 'src')) {
  const out = new Map();
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
  const literal = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text
    : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((sp, i) => `{${i}}${sp.literal.text}`).join('') : null);
  for (const f of walk(srcDir)) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
    const inRoutes = f.includes(`${path.sep}routes${path.sep}`);
    const panelFile = PANEL_FILES.some((name) => f.endsWith(name));
    // Lo que lee la IA (herramientas del Copiloto, el motor) y la documentación de la API no se muestra en el panel.
    const forModel = MODEL_PATHS.some((p) => f.includes(p));
    const visit = (n) => {
      const found = [];
      if (ts.isNewExpression(n) && n.expression.getText(sf) === 'HttpError' && n.arguments?.[1]) found.push(n.arguments[1]);
      if (ts.isCallExpression(n) && ['notFound', 'assertAccount'].includes(n.expression.getText(sf))) found.push(...n.arguments);
      if (inRoutes && ts.isPropertyAssignment(n) && ['error', 'message'].includes(n.name.getText(sf))) found.push(n.initializer);
      // Textos que el servidor arma para mostrarse en el panel (títulos de avisos, nombres y explicaciones de eventos,
      // revisiones del sistema): por el nombre de la propiedad, o todo el texto de los archivos que solo hacen eso.
      if (!forModel && ts.isPropertyAssignment(n) && PANEL_PROPS.has(n.name.getText(sf))) found.push(n.initializer);
      if (panelFile && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && !ts.isImportDeclaration(n.parent) && !ts.isTemplateSpan(n.parent)) found.push(n);
      for (const c of found) {
        for (const x of ts.isConditionalExpression(c) ? [c.whenTrue, c.whenFalse] : [c]) {
          const text = literal(x);
          if (text && /\p{L}{2}/u.test(text) && / /.test(text.trim()) && isText(text)) {
            const k = normalizeKey(text);
            if (!out.has(k)) out.set(k, []);
            out.get(k).push(`${path.relative(path.resolve(here, '..'), f)}:${sf.getLineAndCharacterOfPosition(x.getStart(sf)).line + 1}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Como se guardan las llaves: espacios juntos y sin espacios a los lados (el traductor compara igual). */
export const normalizeKey = (s) => s.replace(/\s+/g, ' ').trim();

const here = path.dirname(new URL(import.meta.url).pathname);
export const PUBLIC_DIR = path.resolve(here, '..', 'public');

/** Revisa el panel contra el diccionario: lo que falta traducir y las traducciones que ya no se usan. */
export function checkTranslations({ dir = path.join(PUBLIC_DIR, 'js'), dictFile = path.join(PUBLIC_DIR, 'i18n', 'en.json'), ignoreFile = path.join(here, 'i18n-ignore.json') } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => path.join(dir, f));
  const found = extractStrings(files);
  for (const [k, at] of serverStrings()) if (!found.has(k)) found.set(k, at);
  const dict = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
  const known = new Set(Object.keys(dict).map(normalizeKey));
  const ignore = new Set(fs.existsSync(ignoreFile) ? JSON.parse(fs.readFileSync(ignoreFile, 'utf8')).map(normalizeKey) : []);
  const missing = [...found.entries()].filter(([k]) => !known.has(k) && !ignore.has(k)).map(([s, at]) => ({ s, at: at.slice(0, 3) }));
  // La traducción puede dejar fuera una parte que en inglés sobra (la «s» o «es» del plural en español), pero no
  // inventar una que el original no tiene.
  const placeholders = (k) => new Set(k.match(/\{\d+\}/g) || []);
  const broken = Object.entries(dict).filter(([k, v]) => typeof v !== 'string' || !v.trim() || [...placeholders(v)].some((p) => !placeholders(k).has(p))).map(([k]) => k);
  return { total: found.size, missing, broken };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { total, missing, broken } = checkTranslations();
  if (process.argv.includes('--missing')) {
    console.log(JSON.stringify(missing, null, 1));
  } else {
    if (broken.length) console.error(`Traducciones vacías o con partes {0} distintas al original:\n  ${broken.join('\n  ')}`);
    if (missing.length) console.error(`Faltan ${missing.length} textos en public/i18n/en.json (o en scripts/i18n-ignore.json si no se ven en la pantalla):\n${missing.slice(0, 50).map((m) => `  ${JSON.stringify(m.s)}  (${m.at[0]})`).join('\n')}`);
    if (missing.length || broken.length) process.exit(1);
    console.log(`Traducción al inglés OK: ${total} textos del panel`);
  }
}
