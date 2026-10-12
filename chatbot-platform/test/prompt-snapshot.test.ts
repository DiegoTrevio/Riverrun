/**
 * Fotografía del prompt: el texto completo que recibe la IA para cuatro agentes tipo. Cualquier cambio en el prompt
 * aparece aquí como diferencia de texto, para revisarlo a propósito.
 *
 * Para aceptar un cambio intencional: UPDATE_PROMPT_SNAPSHOTS=1 npm test -- test/prompt-snapshot.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { buildContext } = await import('../src/engine/context.js');
const { CASES } = await import('./prompt-fixtures.js');

const DIR = path.resolve('test/snapshots/prompt');
const UPDATE = process.env.UPDATE_PROMPT_SNAPSHOTS === '1';

/* ------------------------------ Fotografía ------------------------------ */

function render(name: string): string {
  const ctx = buildContext(CASES[name]());
  const system = ctx.messages[0].content;
  const header = `# Prompt «${name}»: ${system.length} caracteres de instrucciones, ${ctx.messages.length} mensajes en total`;
  return [header, ...ctx.messages.map((m) => `\n======== ${m.role} ========\n${m.content}`)].join('\n') + '\n';
}

for (const name of Object.keys(CASES)) {
  test(`prompt «${name}» igual a su fotografía`, () => {
    const file = path.join(DIR, `${name}.txt`);
    const actual = render(name);
    if (UPDATE || !fs.existsSync(file)) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, actual);
      if (!UPDATE) assert.fail(`No existía la fotografía ${path.relative(process.cwd(), file)}: se creó; revísala y vuelve a correr la prueba.`);
      return;
    }
    assert.equal(actual, fs.readFileSync(file, 'utf8'), `El prompt «${name}» cambió. Si es intencional: UPDATE_PROMPT_SNAPSHOTS=1 npm test -- test/prompt-snapshot.test.ts`);
  });
}
