/**
 * Pase funcional por área: cada archivo de scripts/buttons/areas/ comprueba que sus botones dejan el estado que
 * promete su etiqueta (en la base o en el servicio simulado), que un fallo del servidor se ve y no deja el control
 * mintiendo, y que cada rol ve lo que le toca. Las pruebas de cada hallazgo (BOTÓN-NNN) viven en su área.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';

export type AreaContext = {
  h: any; f: any; base: string; pool: any;
  /** Pestaña de un rol con la sesión puesta; los errores de JavaScript quedan anotados. */
  open: (role: 'admin' | 'agent' | 'superadmin', options?: Parameters<Browser['newContext']>[0]) => Promise<{ page: Page; context: BrowserContext }>;
  /** Abre una pantalla del panel y espera a que termine de cargar. */
  go: (page: Page, route: string) => Promise<void>;
  check: (label: string) => void;
};
export type AreaResult = { area: string; passed: string[]; failed: { check: string; error: string }[]; pageErrors: string[] };

/** Espera el aviso emergente con ese texto (no otro texto igual que ya estaba en la página, como una etiqueta «Cerrada»). */
export const toast = (page: Page, text: string | RegExp) =>
  page.locator('#toast, #toast-alert').filter({ hasText: typeof text === 'string' ? new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : text }).first().waitFor();

export async function runAreas(base: Omit<AreaContext, 'check' | 'open' | 'go'> & { contextFor: (role: string, options?: any) => Promise<BrowserContext> }, log: (m: string) => void) {
  const dir = path.resolve(import.meta.dirname, 'areas');
  const results: AreaResult[] = [];
  // BUTTONS_AREA=agenda,global corre solo esas áreas (para trabajar en una).
  const pick = (process.env.BUTTONS_AREA || '').split(',').filter(Boolean);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mts') && (!pick.length || pick.includes(f.replace(/\.mts$/, '')))).sort()) {
    const area = file.replace(/\.mts$/, '');
    const result: AreaResult = { area, passed: [], failed: [], pageErrors: [] };
    const contexts: BrowserContext[] = [];
    const ctx: AreaContext = {
      ...base,
      open: async (role, options) => {
        const context = await base.contextFor(role, options); contexts.push(context);
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', (e) => result.pageErrors.push(`${role}: ${e.message}`));
        return { page, context };
      },
      go: async (page, route) => {
        await page.goto(`${base.base}/#/${route}`);
        await page.locator('.main h1, main h1').first().waitFor();
        await page.locator('.main [aria-busy="true"]').first().waitFor({ state: 'hidden' }).catch(() => {});
      },
      check: (label) => { result.passed.push(label); log(`  ✓ ${area}: ${label}`); },
    };
    const mod = await import(path.join(dir, file));
    // Cada comprobación es independiente: una que falla no detiene las demás del área.
    for (const [label, fn] of Object.entries(mod.checks as Record<string, (c: AreaContext) => Promise<void>>)) {
      try { await fn(ctx); ctx.check(label); }
      catch (e: any) { result.failed.push({ check: label, error: e.message.split('\n').slice(0, 12).join(' ') }); log(`  ✗ ${area}: ${label} — ${e.message.split('\n').slice(0, 12).join(' ')}`); }
      finally { await Promise.all(contexts.splice(0).map((c) => c.close().catch(() => {}))); }
    }
    results.push(result);
  }
  return results;
}
