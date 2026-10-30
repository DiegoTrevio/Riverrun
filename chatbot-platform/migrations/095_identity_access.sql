-- Seguridad, etapa 2a (acceso): verificación en dos pasos obligatoria, códigos de recuperación, dispositivos y límites de
-- intentos que comparten todos los procesos y sobreviven a un reinicio.

-- 2FA con app de autenticación (TOTP). El secreto va cifrado (AES-256-GCM con la llave de SESSION_SECRET); el pendiente
-- es el que se está configurando. El último paso aceptado impide usar dos veces el mismo código.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint NOT NULL DEFAULT 0;
-- Demasiados códigos equivocados: la verificación queda bloqueada hasta esta hora.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_locked_until timestamptz;

-- Códigos de recuperación: solo su hash; cada uno sirve una vez.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- Dispositivos de cada persona: el conocido (para avisar de uno nuevo) y, si lo pidió, recordado 30 días (salta el
-- código, nunca la contraseña). Solo se guardan hashes de las cookies.
CREATE TABLE IF NOT EXISTS user_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash   text NOT NULL,
  trust_hash    text UNIQUE,
  trusted_until timestamptz,
  user_agent    text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 300),
  ip            text NOT NULL DEFAULT '' CHECK (length(ip) <= 64),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_hash)
);

-- Cuándo escribió el código por última vez en esa sesión (verificación reciente para acciones delicadas).
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS mfa_at timestamptz;

-- Límites de intentos: un contador por clave que vuelve a cero al vencer su ventana.
CREATE TABLE IF NOT EXISTS rate_limits (
  key        text PRIMARY KEY,
  hits       integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expires_idx ON rate_limits (expires_at);

-- Nadie entra ya sin código: las sesiones abiertas se cierran (la plataforma no se ha lanzado).
UPDATE user_sessions SET revoked_at = now() WHERE revoked_at IS NULL;
