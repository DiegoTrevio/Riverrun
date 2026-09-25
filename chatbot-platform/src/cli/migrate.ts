import { migrate, pool } from '../db.js';

const applied = await migrate();
console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'La base de datos ya está al día');
await pool.end();
