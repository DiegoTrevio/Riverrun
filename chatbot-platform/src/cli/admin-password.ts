/**
 * Recupera el acceso del superadministrador (o lo crea si no existe): `./riverrun admin-password [correo]`.
 * Genera una contraseña nueva y la muestra una sola vez; con `--stdin` la lee de la entrada (así no queda en el historial
 * ni en la lista de procesos). Cierra todas sus sesiones abiertas.
 */
import { z } from 'zod';
import { resetSuperadminPassword } from '../auth.js';
import { config } from '../config.js';
import { pool } from '../db.js';

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const args = process.argv.slice(2);
  const given = args.find((a) => !a.startsWith('--')) ?? config.adminUser;
  const email = z.email().safeParse(given).data;
  if (!email) throw new Error(`«${given}» no es un correo válido: ./riverrun admin-password tu@correo.com`);
  const typed = args.includes('--stdin') ? (await readStdin()).trim() : '';
  const r = await resetSuperadminPassword(email, typed || undefined);
  console.log(`${r.created ? 'Superadministrador creado' : 'Contraseña restablecida'}: ${email}`);
  if (!typed) console.log(`Contraseña nueva: ${r.password}`);
  console.log('Sus sesiones abiertas se cerraron. Guárdala en tu gestor de contraseñas.');
  // El límite de intentos lo lleva el servidor en memoria: este comando no lo puede levantar.
  console.log('Si tu conexión quedó bloqueada por intentos fallidos, espera 15 minutos o reinicia (./riverrun restart).');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo cambiar la contraseña');
  process.exitCode = 1;
} finally {
  await pool.end();
}
