-- ID-16: el primer enrolamiento de 2FA con solo la contraseña (cuentas que ya existían, «Restablecer 2FA», usuarios que
-- crea un administrador) pide un enlace al correo de la cuenta: quien tenga una contraseña filtrada no enrola su app.
--   * mfa_enroll_token_hash / mfa_enroll_sent_at: el enlace vigente (SHA-256 del token de 256 bits, 1 hora, un solo uso).
--   * totp_email_confirmed: la app se configuró pasando por el correo (registro, invitación, Google o el enlace). Las que ya
--     existen no lo están: restablecer la contraseña por correo las quita.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enroll_token_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enroll_sent_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_email_confirmed boolean NOT NULL DEFAULT false;
