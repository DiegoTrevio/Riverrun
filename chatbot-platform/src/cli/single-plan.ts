/**
 * Deja Riverrun con su plan único: `./riverrun plan-unico` (o `npm run plans:single`). Crea o actualiza «Riverrun» a
 * 5,000 MXN + IVA al mes y su precio de 270 USD (privado; `--usd-publico` lo publica), y apaga los demás planes. Quien ya
 * pagaba un plan apagado lo conserva; nadie nuevo lo puede contratar. Se puede correr las veces que se quiera.
 */
import { pool } from '../db.js';
import { applySinglePlan, singlePlans, worstMonthCostUsd } from '../billing/single-plan.js';

try {
  const usdPublic = process.argv.includes('--usd-publico');
  const r = await applySinglePlan({ usdPublic });
  const [mx, us] = singlePlans({ usdPublic });
  console.log(`Plan único listo: ${mx.name} a $${mx.price.toLocaleString('es-MX')} MXN + IVA al mes y $${us.price} USD al mes (${us.public ? 'publicado' : 'privado hasta tener la versión en inglés'}).`);
  console.log(`Incluye: ${mx.limits.messages_per_month?.toLocaleString('es-MX')} mensajes del asistente al mes, ${mx.limits.channels} canales, ${mx.limits.social_accounts} redes sociales, ${mx.limits.users} personas, ${mx.limits.chatbots} asistentes y ${(mx.limits.storage_mb ?? 0) / 1024} GB de archivos.`);
  console.log(`Costo máximo por negocio (Zernio + IA al tope): ${worstMonthCostUsd(mx.limits, mx.ai_usd_per_month)} USD al mes.`);
  console.log(r.deactivated.length ? `Planes apagados (quien ya los paga los conserva): ${r.deactivated.join(', ')}.` : 'No había otros planes activos.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo aplicar el plan único');
  process.exitCode = 1;
} finally {
  await pool.end();
}
