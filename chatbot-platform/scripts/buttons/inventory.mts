/**
 * Inventario estático de los controles del panel: cada lugar del código que crea un control con un manejador de clic,
 * cambio, envío o despliegue. Un "sitio" es archivo:línea de la llamada a h() (o del addEventListener directo). La
 * auditoría en el navegador anota el mismo sitio para cada control que presiona, y así se cruzan las dos listas.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type Site = { site: string; file: string; line: number; endLine: number; events: string[]; tag: string; label: string };

/** Eventos que hacen algo al usarse (un botón, una casilla, un formulario, un desplegable). */
export const ACTION_EVENTS = ['click', 'change', 'submit', 'toggle'];
/** Arrastrar y soltar: no los presiona el recorrido automático; los cubre su prueba por área. */
export const DRAG_EVENTS = ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend', 'pointerdown'];

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'js');

const literal = (node: ts.Node | undefined): string => {
  if (!node) return '';
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => '…' + s.literal.text).join('');
  return '';
};

export function staticInventory(dir = DIR): Site[] {
  const sites: Site[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(dir, file), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        // h('button', { onclick, … }, …)
        if (ts.isIdentifier(callee) && callee.text === 'h' && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
          const events = node.arguments[1].properties
            .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : ''))
            .filter((n) => /^on[a-z]+$/.test(n)).map((n) => n.slice(2))
            .filter((e) => ACTION_EVENTS.includes(e) || DRAG_EVENTS.includes(e));
          if (events.length) {
            const line = lineOf(callee.getStart(source));
            const label = node.arguments.slice(2).map(literal).find(Boolean)
              || literal((node.arguments[1].properties.find((p) => p.name && ts.isIdentifier(p.name) && ['aria-label', 'title'].includes(p.name.text)) as ts.PropertyAssignment | undefined)?.initializer);
            sites.push({ site: `${file}:${line}`, file, line, endLine: lineOf(node.arguments[1].getEnd()), events, tag: literal(node.arguments[0]) || '?', label });
          }
        }
        // algo.addEventListener('click', …) sobre un elemento (no document/window: esos son atajos globales).
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'addEventListener' && node.arguments[0]) {
          const event = literal(node.arguments[0]);
          const target = callee.expression.getText(source);
          if ((ACTION_EVENTS.includes(event) || DRAG_EVENTS.includes(event)) && !/^(document|window|globalThis)$/.test(target)) {
            const line = lineOf(callee.name.getStart(source));
            sites.push({ site: `${file}:${line}`, file, line, endLine: line, events: [event], tag: target, label: '' });
          }
        }
      }
      // boton.onclick = … (manejador asignado como propiedad).
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)
        && /^on(click|change|submit|toggle)$/.test(node.left.name.text)) {
        const line = lineOf(node.left.name.getStart(source));
        sites.push({ site: `${file}:${line}`, file, line, endLine: line, events: [node.left.name.text.slice(2)], tag: node.left.expression.getText(source), label: '' });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/**
 * Llave estable de cada sitio, sin el número de línea (cambia con cualquier edición del archivo): archivo, control,
 * etiqueta, eventos y cuántos iguales hay antes en el mismo archivo.
 */
export function withKeys<T extends Site>(sites: T[]): (T & { key: string })[] {
  const seen = new Map<string, number>();
  return sites.map((s) => {
    const base = `${s.file}|${s.tag}|${s.label}|${s.events.join(',')}`;
    const n = seen.get(base) ?? 0; seen.set(base, n + 1);
    return { ...s, key: `${base}|${n}` };
  });
}

/** Encuentra el sitio estático de una línea vista en el navegador (la llamada puede ocupar varias líneas). */
export function matchSite(sites: Site[], file: string, line: number): Site | undefined {
  return sites.find((s) => s.file === file && s.line === line) || sites.find((s) => s.file === file && line >= s.line && line <= s.endLine);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sites = staticInventory();
  const byFile = Object.entries(Object.groupBy(sites, (s) => s.file)).map(([f, list]) => `${f.padEnd(24)} ${list!.length}`);
  console.log(byFile.join('\n'));
  console.log(`Total: ${sites.length} sitios (${sites.filter((s) => s.events.some((e) => ACTION_EVENTS.includes(e))).length} de acción)`);
}
