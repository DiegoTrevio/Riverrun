/** Plataforma: el selector de perfil del maestro y lo que ve un admin que escribe la dirección de una pantalla del maestro. */
import assert from 'node:assert/strict';
import { toast, type AreaContext } from '../areas.mts';

const PER_ACCOUNT = ['comentarios', 'publicaciones', 'cobros', 'estadisticas', 'integraciones', 'redes', 'datos-clientes'];

export const checks = {
  'Con «Todos los perfiles», cada pantalla de un perfil pide elegirlo en lugar de fallar': async ({ open, go, h, base }: AreaContext) => {
    const { page } = await open('superadmin');
    const failed: string[] = [];
    for (const route of PER_ACCOUNT) {
      await go(page, 'agentes');
      await page.locator('#profile-switch').selectOption('');
      await page.goto(`${base}/#/${route}`);
      await page.locator('.main [aria-busy="true"]').first().waitFor({ state: 'hidden' }).catch(() => {});
      await page.waitForTimeout(600);
      const picker = page.getByRole('heading', { name: '¿Qué perfil quieres gestionar?' });
      if (!(await picker.count())) { failed.push(`${route}: ${(await page.locator('.main').innerText()).replace(/\s+/g, ' ').slice(0, 120)}`); continue; }
      // Elegir el perfil ahí mismo abre la pantalla con sus datos.
      await page.getByRole('combobox', { name: 'Perfil de negocio' }).last().selectOption(h.accountId);
      await page.locator('.main').getByRole('button').filter({ hasText: /Continuar|Gestionar|Elegir|Abrir/ }).first().click();
      await page.waitForTimeout(500);
      if (await picker.count()) failed.push(`${route}: elegir el perfil no abrió la pantalla`);
    }
    // Se deja elegido el perfil de la auditoría.
    await page.evaluate((id) => localStorage.setItem('cp-account', id), h.accountId);
    assert.deepEqual(failed, [], 'Pantallas que fallan sin perfil elegido');
  },
  'Un admin que abre a mano una pantalla del maestro no ve sus datos y recibe un aviso': async ({ open, base }: AreaContext) => {
    const { page } = await open('admin');
    const leaks: string[] = [];
    for (const route of ['sistema', 'sistema/zernio', 'marcas', 'negocio', 'accounts', 'planes']) {
      const codes: number[] = [];
      // Solo lo que es de la plataforma (no lo que toda pantalla pide de fondo, ni los planes que el admin ve en «Mi plan»).
      const listen = (r: any) => { if (/^\/api\/(system|brands|business|billing\/overview|accounts\/)/.test(new URL(r.url()).pathname)) codes.push(r.status()); };
      page.on('response', listen);
      await page.goto(`${base}/#/${route}`);
      await page.locator('.main h1, .main [role=alert], .main .banner').first().waitFor();
      await page.waitForTimeout(400);
      page.off('response', listen);
      if (codes.some((c) => c < 300)) leaks.push(`${route}: el servidor respondió ${codes.join(',')}`);
      const text = (await page.locator('.main').innerText()).replace(/\s+/g, ' ');
      if (!/No pudimos|permiso|maestro|superadmin|no encontrada|No tienes/i.test(text) && !/#\/(conversations|agentes)$/.test(new URL(page.url()).hash)) leaks.push(`${route}: sin aviso (${text.slice(0, 100)})`);
    }
    assert.deepEqual(leaks, []);
  },
  'Planes y cobro: capturar el tipo de cambio de un pago en otra moneda libera su factura en espera (PAY-9)': async ({ open, go, h, pool }: AreaContext) => {
    const pay = (await pool.query(
      `INSERT INTO billing_payments (account_id, provider, provider_payment_id, currency, total_cents, subtotal_cents, tax_cents, tax_percent, paid_at)
       VALUES ($1, 'stripe', 'in_botones_usd', 'USD', 3364, 2900, 464, 16, now()) RETURNING id`, [h.accountId])).rows[0].id;
    const cfdi = (await pool.query(
      `INSERT INTO cfdi_invoices (kind, account_id, payment_id, hold, last_error) VALUES ('payment', $1, $2, 'exchange_rate', 'pendiente: tipo de cambio') RETURNING id`,
      [h.accountId, pay])).rows[0].id;
    try {
      const { page } = await open('superadmin');
      await go(page, 'planes');
      const card = page.locator('section', { has: page.getByRole('heading', { name: 'Facturas que esperan el tipo de cambio' }) });
      await card.getByRole('spinbutton').first().fill('17.4');
      await card.getByRole('button', { name: 'Guardar' }).first().click();
      await toast(page, 'Guardado: la factura sale en la siguiente revisión');
      const p = (await pool.query(`SELECT exchange_rate FROM billing_payments WHERE id = $1`, [pay])).rows[0];
      const c = (await pool.query(`SELECT hold FROM cfdi_invoices WHERE id = $1`, [cfdi])).rows[0];
      assert.deepEqual([Number(p.exchange_rate), c.hold], [17.4, '']);
    } finally {
      // Solo lo que esta comprobación creó.
      await pool.query(`DELETE FROM cfdi_invoices WHERE id = $1`, [cfdi]);
      await pool.query(`DELETE FROM billing_payments WHERE id = $1`, [pay]);
    }
  },
};
