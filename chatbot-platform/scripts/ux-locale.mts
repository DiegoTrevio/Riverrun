/**
 * Las pruebas del panel en el navegador revisan los textos en español. El panel elige el idioma del navegador si la
 * persona no eligió uno, y Chromium de pruebas viene en inglés: aquí cada contexto nuevo nace en español (es-MX) salvo
 * que la prueba pida otro idioma (test-english-ux.mts pide en-US). Se importa antes de abrir el navegador.
 */
import { chromium } from 'playwright';

const launch = chromium.launch.bind(chromium);
(chromium as any).launch = async (...args: Parameters<typeof chromium.launch>) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = ((options: Parameters<typeof newContext>[0] = {}) => newContext({ locale: 'es-MX', ...options })) as typeof newContext;
  const newPage = browser.newPage.bind(browser);
  browser.newPage = ((options: Parameters<typeof newPage>[0] = {}) => newPage({ locale: 'es-MX', ...options })) as typeof newPage;
  return browser;
};
