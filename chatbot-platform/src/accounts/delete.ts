/**
 * Borrado completo de una cuenta: su suscripción deja de cobrar, la base (en cascada), sus archivos, su WhatsApp en
 * Evolution y su rastro en Zernio. Lo usan el superadmin y la retención automática. Los pagos y la constancia de términos
 * se conservan sin la cuenta (contabilidad y prueba legal).
 */
import fsp from 'node:fs/promises';
import { scheduleJob } from '../automation/store.js';
import { providers, getSubscription, queueAction } from '../billing/service.js';
import { releaseWhatsapp } from '../channels/whatsapp.js';
import { zernioFootprint } from '../channels/zernio-connect.js';
import { query } from '../db.js';
import { imageAbsolutePath } from '../engine/transport.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import type { Account } from '../types.js';

/**
 * Cancela en el proveedor la suscripción que siga cobrando. Si no se puede ahora, queda pendiente y se reintenta sola
 * (sobrevive al borrado de la cuenta); solo si se agotan los intentos se avisa al superadmin.
 */
async function stopCharging(acc: Account) {
  const sub = await getSubscription(acc.id);
  if (!sub?.provider_subscription_id || !['active', 'past_due'].includes(sub.status) || sub.cancel_at_period_end) return;
  try {
    await providers[sub.provider].setCancelAtPeriodEnd(sub, true);
  } catch (e: any) {
    await logEvent({ level: 'warn', source: 'admin', message: `No se pudo cancelar la suscripción de la cuenta borrada ${acc.name}, se reintenta: ${e?.message ?? e}`, accountId: acc.id });
    await queueAction({ provider: sub.provider, kind: 'cancel', ref: sub.provider_subscription_id, accountId: acc.id, reason: 'deleted' });
  }
}

export async function deleteAccountFully(acc: Account) {
  await stopCharging(acc);
  const images = await query<{ file_path: string }>(`SELECT i.file_path FROM images i JOIN chatbots b ON b.id = i.chatbot_id WHERE b.account_id = $1`, [acc.id]);
  const whatsapps = (await store.listChannels(acc.id)).filter((c) => c.type === 'whatsapp');
  const zernio = await zernioFootprint(acc.id);
  await store.deleteAccount(acc.id);
  // Sus redes y su perfil se quitan de Zernio aparte (con reintentos): el negocio ya no existe.
  if (zernio.accounts.length || zernio.profiles.length || zernio.posts.length) await scheduleJob({ account_id: null, type: 'zernio_cleanup', payload: zernio, run_at: new Date() });
  for (const ch of whatsapps) await releaseWhatsapp(ch, { accountDeleted: true });
  for (const i of images) await fsp.rm(imageAbsolutePath(i), { force: true });
}
