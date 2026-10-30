-- Seguridad, etapa 2b (cuenta): dueño de cada cuenta, Google por su identificador, quién creó cada webhook y el enlace
-- para cambiar el correo.

-- Google entra por su identificador estable (`sub`), no por el correo: si la persona cambia su correo aquí, sigue.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Al dar de baja a alguien se pausan los webhooks que creó (como se revocan sus llaves de API).
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS webhook_endpoints_created_by_idx ON webhook_endpoints (created_by);

-- Cambiar el correo: el enlace va al correo nuevo, que se guarda junto al token hasta que se abre.
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_kind_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_check CHECK (kind IN ('verify_email', 'reset_password', 'change_email'));

-- Toda cuenta con administradores tiene dueño: el que ya tenía si es un administrador activo de ella, si no el
-- administrador activo más antiguo.
UPDATE accounts a SET owner_user_id = (
    SELECT u.id FROM users u WHERE u.account_id = a.id AND u.role = 'admin' AND u.active ORDER BY u.created_at, u.id LIMIT 1
  )
  WHERE NOT EXISTS (SELECT 1 FROM users o WHERE o.id = a.owner_user_id AND o.account_id = a.id AND o.role = 'admin' AND o.active)
    AND EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id AND u.role = 'admin' AND u.active);
