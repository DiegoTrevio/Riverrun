/** Avisos de seguridad por correo: cada evento con su asunto, sin enlaces con token y con qué hacer si no fue la persona. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, migrate, pool } from './harness.js';

const ok = await dbAvailable();
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !ok && 'PostgreSQL de pruebas no disponible' }, fn);
const { notifyUser } = await import('../src/identity/notices.js');
const { outbox } = await import('../src/mailer.js');

const ana = { id: '00000000-0000-4000-8000-000000000001', email: 'ana@negocio.mx', name: 'Ana', account_id: null };
const FOOTER = 'Si no fuiste tú: cambia tu contraseña y cierra todas las sesiones desde Mi perfil.';
const last = () => outbox.at(-1)!;

before(async () => {
  if (!ok) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
});
after(async () => {
  await pool.end();
});

t('cada evento manda su asunto, saluda y termina con qué hacer si no fue la persona', async () => {
  const subjects = {
    password_changed: 'Tu contraseña cambió',
    password_reset: 'Restableciste tu contraseña',
    mfa_enabled: 'Activaste la verificación en dos pasos',
    mfa_changed: 'Cambiaste tu app de verificación',
    mfa_reset: 'Se restableció tu verificación en dos pasos',
    recovery_used: 'Usaste un código de recuperación',
    recovery_regenerated: 'Generaste códigos de recuperación nuevos',
    mfa_locked: 'Bloqueamos tu verificación por intentos fallidos',
    new_device: 'Nuevo inicio de sesión en tu cuenta',
  } as const;
  for (const [kind, subject] of Object.entries(subjects)) {
    const before = outbox.length;
    await notifyUser(ana, kind as keyof typeof subjects, { device: 'Chrome en Windows', ip: '203.0.113.7', remaining: 3, by: 'Luis' });
    assert.equal(outbox.length, before + 1, kind);
    assert.equal(last().to, 'ana@negocio.mx', kind);
    assert.equal(last().subject, subject, kind);
    assert.match(last().text, /^Hola Ana,/, kind);
    assert.ok(last().text.trimEnd().endsWith(FOOTER), kind);
    assert.doesNotMatch(last().text, /token|#\/restablecer|https?:\/\//i, kind);
  }
});

t('los detalles: códigos que quedan, dispositivo con IP parcial y quién restableció', async () => {
  await notifyUser(ana, 'recovery_used', { remaining: 3 });
  assert.match(last().text, /Te quedan 3 códigos/);
  await notifyUser(ana, 'new_device', { device: 'Safari en iPhone o iPad', ip: '203.0.113.7' });
  assert.match(last().text, /Safari en iPhone o iPad/);
  assert.match(last().text, /203\.0\.…/);
  assert.doesNotMatch(last().text, /203\.0\.113\.7/);
  await notifyUser(ana, 'mfa_reset', { by: 'Luis' });
  assert.match(last().text, /Luis restableció/);
});
