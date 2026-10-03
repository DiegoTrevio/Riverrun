-- Autoregistro de empresas, periodo de prueba, verificación de correo y costo de IA por cuenta.

-- Estado comercial de la cuenta (independiente de "active", que bloquea todo el acceso):
--   trial  = en prueba hasta trial_ends_at
--   active = activa (la activa el superadmin; más adelante, el cobro)
--   paused = el panel funciona, pero no se envía nada (bot, campañas, respuestas)
ALTER TABLE accounts
  ADD COLUMN status          text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'paused')),
  ADD COLUMN plan            text NOT NULL DEFAULT '',
  ADD COLUMN trial_ends_at   timestamptz,
  ADD COLUMN trial_warned_at timestamptz,
  ADD COLUMN business_type   text NOT NULL DEFAULT '',
  ADD COLUMN owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN onboarding      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN signup_source   text NOT NULL DEFAULT 'admin',
  ADD COLUMN ai_alert_month  text NOT NULL DEFAULT '';  -- último mes (AAAA-MM) en que se avisó de gasto alto
CREATE INDEX accounts_trial_idx ON accounts (trial_ends_at) WHERE status = 'trial';

-- Los usuarios existentes (creados por un administrador) se dan por verificados.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
UPDATE users SET email_verified_at = created_at;

CREATE TABLE auth_tokens (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, kind);

-- Precios de OpenAI en USD (editables por el superadmin). El modelo se busca por prefijo más largo:
-- "gpt-4.1-mini-2025-04-14" usa el precio de "gpt-4.1-mini".
CREATE TABLE ai_prices (
  model            text PRIMARY KEY,
  input_per_mtok   numeric(12, 4) NOT NULL DEFAULT 0,
  cached_per_mtok  numeric(12, 4) NOT NULL DEFAULT 0,
  output_per_mtok  numeric(12, 4) NOT NULL DEFAULT 0,
  per_audio_minute numeric(12, 5) NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_prices (model, input_per_mtok, cached_per_mtok, output_per_mtok, per_audio_minute) VALUES
  ('gpt-4.1',                 2.00, 0.50,  8.00, 0),
  ('gpt-4.1-mini',            0.40, 0.10,  1.60, 0),
  ('gpt-4.1-nano',            0.10, 0.025, 0.40, 0),
  ('gpt-4o',                  2.50, 1.25, 10.00, 0),
  ('gpt-4o-mini',             0.15, 0.075, 0.60, 0),
  ('gpt-5',                   1.25, 0.125, 10.00, 0),
  ('gpt-5-mini',              0.25, 0.025, 2.00, 0),
  ('gpt-5-nano',              0.05, 0.005, 0.40, 0),
  ('gpt-4o-mini-transcribe',  0,    0,     0,    0.003),
  ('gpt-4o-transcribe',       0,    0,     0,    0.006),
  ('whisper-1',               0,    0,     0,    0.006);

-- Costo de cada llamada, calculado al registrarla (el histórico no cambia si cambian los precios).
ALTER TABLE ai_runs
  ADD COLUMN audio_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN cost_usd      numeric(14, 6) NOT NULL DEFAULT 0;

-- Último estado de conexión conocido del canal (WhatsApp: open | connecting | close), para el panel y las alertas.
ALTER TABLE channels
  ADD COLUMN connection_state    text NOT NULL DEFAULT '',
  ADD COLUMN connection_state_at timestamptz;
