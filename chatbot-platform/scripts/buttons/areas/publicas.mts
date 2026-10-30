/** Sin sesión: entrar (con la contraseña equivocada y con la buena, más el código) y recuperar la contraseña con el correo que llega. */
import assert from 'node:assert/strict';
import { outbox } from '../../../src/mailer.js';
import type { AreaContext } from '../areas.mts';

async function anonymous(open: AreaContext['open']) {
  const { page, context } = await open('admin');
  await context.clearCookies();
  return page;
}

export const checks = {
  'Entrar: la contraseña equivocada muestra el error y no entra; la buena abre el panel': async ({ h, base, open }: AreaContext) => {
    const page = await anonymous(open);
    await page.goto(`${base}/#/login`); await page.locator('main h1').first().waitFor();
    await page.getByLabel('Correo').fill('admin@auditoria.test');
    await page.getByLabel('Contraseña').fill('no-es-la-contraseña');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.locator('.form-error, [role=alert]').filter({ hasText: /\S/ }).first().waitFor();
    assert.match(page.url(), /#\/login/);
    await page.getByLabel('Contraseña').fill('Pz-100-Qx-300-Kv');
    await page.getByRole('button', { name: 'Entrar' }).click();
    // Segundo paso: el código de su app.
    await page.waitForURL(/#\/login\/codigo/);
    await page.getByLabel('Código de 6 dígitos').fill(await h.codeFor('admin@auditoria.test'));
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.locator('.main h1').first().waitFor();
    assert.doesNotMatch(page.url(), /#\/login/);
  },
  'Recuperar contraseña: llega el correo y su enlace deja elegir otra con la que se entra': async ({ h, base, open }: AreaContext) => {
    await h.addUser({ account_id: h.accountId, name: 'Persona que olvidó', email: 'olvido@auditoria.test', password: 'Pz-100-Qx-300-Kv', role: 'agent' });
    const page = await anonymous(open);
    await page.goto(`${base}/#/olvide`); await page.locator('main h1').first().waitFor();
    const before = outbox.length;
    await page.getByLabel('Correo').fill('olvido@auditoria.test');
    await page.getByRole('button', { name: 'Enviar enlace' }).click();
    await page.getByText(/te enviamos un enlace/).waitFor();
    // El correo sale en segundo plano, después de responder.
    for (let i = 0; i < 50 && !outbox.slice(before).some((m: any) => String(m.to).includes('olvido@auditoria.test')); i++) await page.waitForTimeout(100);
    const mail = outbox.slice(before).find((m: any) => String(m.to).includes('olvido@auditoria.test'));
    assert.ok(mail, 'no salió el correo para recuperar la contraseña');
    const link = (JSON.stringify(mail).match(/#\/restablecer\?token=[\w-]+/) || [])[0];
    assert.ok(link, 'el correo no trae el enlace para elegir contraseña');
    await page.goto(`${base}/${link}`); await page.locator('main h1').first().waitFor();
    await page.getByLabel('Contraseña nueva').fill('Pz-153-Qx-353-Kv');
    await page.getByLabel('Repítela').fill('Pz-153-Qx-353-Kv');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Listo, ya puedes entrar con tu contraseña nueva.').waitFor();
    const login = await h.app.inject({ method: 'POST', url: '/api/login', payload: { email: 'olvido@auditoria.test', password: 'Pz-153-Qx-353-Kv' } });
    assert.equal(login.statusCode, 200, 'la contraseña nueva no sirve para entrar');
  },
};
