/** Lo que está en todas las pantallas: la sesión (salir, cerrar las demás) y el menú de la cuenta. */
import assert from 'node:assert/strict';
import type { AreaContext } from '../areas.mts';

/** Una persona aparte para no cerrar la sesión con la que se audita. */
async function person(h: any, email: string) {
  const r = await h.authed('POST', '/api/users', { account_id: h.accountId, name: 'Persona de sesiones', email, password: 'auditoria123', role: 'admin' });
  assert.ok(r.statusCode < 300, r.body);
  return () => h.loginAs(email, 'auditoria123');
}
async function withCookie(open: AreaContext['open'], cookie: string, base: string) {
  const { page, context } = await open('admin');
  await context.clearCookies();
  const ix = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, ix), value: cookie.slice(ix + 1), url: base }]);
  return page;
}

export const checks = {
  'Cerrar sesión (menú de la cuenta) sale del panel y la sesión deja de servir': async ({ h, base, open, go }: AreaContext) => {
    const login = await person(h, 'salir@auditoria.test');
    const session = await login();
    const page = await withCookie(open, session.cookie, base);
    await go(page, 'conversations');
    await page.getByRole('button', { name: /menú de tu cuenta$/ }).click();
    await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
    await page.waitForURL(/#\/login/);
    assert.equal((await session('GET', '/api/me')).statusCode, 401, 'la sesión sigue sirviendo después de salir');
  },
  'Cerrar sesión en todos los demás dispositivos cierra las otras y deja esta': async ({ h, base, open, go }: AreaContext) => {
    const login = await person(h, 'sesiones@auditoria.test');
    const other = await login(); const mine = await login();
    const page = await withCookie(open, mine.cookie, base);
    await go(page, 'password');
    await page.getByRole('button', { name: 'Cerrar sesión en todos los demás dispositivos' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Cerrar las demás' }).click();
    await page.getByText('Sesiones cerradas').first().waitFor();
    assert.equal((await other('GET', '/api/me')).statusCode, 401, 'la otra sesión sigue abierta');
    assert.equal((await mine('GET', '/api/me')).statusCode, 200, 'esta sesión se cerró también');
  },
};
