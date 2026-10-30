-- Etapa 3a (registro): la cuenta nueva espera la tarjeta, y hay una prueba gratis por persona.
--   * pause_reason 'card': registrada, con correo y 2FA, pero sin tarjeta todavía (el asistente no responde).
--   * accounts.signup_plan: el plan que eligió al registrarse, para ofrecerlo al agregar la tarjeta.
--   * system_keys: la llave de las marcas de prueba (vive en la base: rotar SESSION_SECRET no las borra).
--   * trial_claims: marcas HMAC del correo normalizado, la cuenta de Google y la tarjeta (nunca en claro), por 2 años.
--   * card_checks: cada verificación de tarjeta abierta (topes, sesión vigente de 30 minutos y freno).
-- Las cuentas que ya existen no cambian de estado; el correo de su dueño queda marcado (ya no da otra prueba).

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_pause_reason_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_pause_reason_check CHECK (pause_reason IN ('', 'trial', 'payment', 'dispute', 'card'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signup_plan text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS system_keys (
  name text PRIMARY KEY,
  value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_keys (name, value) VALUES ('trial_claims', gen_random_bytes(32)) ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS trial_claims (
  kind text NOT NULL CHECK (kind IN ('email', 'google', 'card')),
  digest bytea NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT '',
  disputed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 years',
  PRIMARY KEY (kind, digest)
);
CREATE INDEX IF NOT EXISTS trial_claims_account_idx ON trial_claims (account_id);

CREATE TABLE IF NOT EXISTS card_checks (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  plan_key text NOT NULL DEFAULT '',
  ref text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  ip_key text NOT NULL DEFAULT '',
  opened_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS card_checks_opened_idx ON card_checks (opened_at);
CREATE INDEX IF NOT EXISTS card_checks_account_idx ON card_checks (account_id, opened_at DESC);

-- La misma normalización que canonicalEmail (src/billing/trial-claims.ts): minúsculas, sin +etiqueta y, en Gmail,
-- sin puntos y con el dominio gmail.com.
CREATE OR REPLACE FUNCTION canonical_email(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH e AS (SELECT lower(btrim(raw)) AS v),
       p AS (SELECT split_part(v, '@', 1) AS local, substr(v, length(split_part(v, '@', 1)) + 2) AS domain FROM e)
  SELECT CASE WHEN domain IN ('gmail.com', 'googlemail.com') THEN replace(split_part(local, '+', 1), '.', '') || '@gmail.com'
              ELSE split_part(local, '+', 1) || '@' || domain END
    FROM p
$$;

-- El correo de los dueños de hoy ya usó su prueba.
INSERT INTO trial_claims (kind, digest, account_id)
SELECT 'email', hmac(convert_to('email:' || canonical_email(u.email), 'UTF8'), k.value, 'sha256'), a.id
  FROM accounts a
  JOIN users u ON u.id = a.owner_user_id
 CROSS JOIN (SELECT value FROM system_keys WHERE name = 'trial_claims') k
ON CONFLICT (kind, digest) DO NOTHING;
