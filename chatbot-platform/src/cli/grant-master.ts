import { z } from 'zod';
import { pool } from '../db.js';
import { grantMasterAccess } from '../store/index.js';

try {
  const email = z.email().parse(process.argv[2] ?? 'diegoa.trevio@gmail.com');
  const user = await grantMasterAccess(email);
  console.log(`Acceso maestro asignado a ${user.email}. Conserva su contraseña actual.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo asignar acceso maestro');
  process.exitCode = 1;
} finally {
  await pool.end();
}
