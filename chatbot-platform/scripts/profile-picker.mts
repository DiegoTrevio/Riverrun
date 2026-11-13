/** Pruebas en navegador: la cuenta maestra elige un perfil ('' = todos) con el selector del menú lateral. */
import type { Page } from 'playwright';

export async function pickProfile(page: Page, accountId: string) {
  await page.locator('#profile-switch').click();
  await page.locator(`.account-switch-panel [role=option][data-account="${accountId}"]`).click();
  await page.waitForFunction((id) => (localStorage.getItem('cp-account') || '') === id, accountId);
}
