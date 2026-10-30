/**
 * Sonda de cobertura para las otras pruebas en navegador (test:ux, test:billing:ux…): se carga antes que la prueba
 *   node --import tsx --import ./scripts/buttons/coverage-probe.mts scripts/test-ux.mts
 * y anota qué controles del panel usa de verdad, sin cambiar cómo se comporta la página. Al salir escribe
 * data/button-audit/pressed-<prueba>.json; test:buttons lo toma como evidencia de «Otra prueba» al regenerar
 * sin-presionar.json (BUTTONS_WRITE_PENDING=1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { INIT_SCRIPT } from './instrument.mts';

const pressed = new Set<string>();
const name = path.basename(process.argv[1] || 'prueba').replace(/\.m?ts$/, '');
const launch = chromium.launch.bind(chromium);
(chromium as any).launch = async (...args: Parameters<typeof chromium.launch>) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = (async (...a: Parameters<typeof newContext>) => {
    const context = await newContext(...a);
    await context.addInitScript('window.__auditProbe = true;');
    await context.addInitScript(INIT_SCRIPT);
    await context.exposeBinding('__auditPressed', (_source, site: string) => { pressed.add(site); });
    return context;
  }) as typeof newContext;
  return browser;
};
process.on('exit', () => {
  const out = path.resolve('data/button-audit');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `pressed-${name}.json`), JSON.stringify([...pressed].sort(), null, 2));
});
