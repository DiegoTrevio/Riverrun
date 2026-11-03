-- Etapa 7 (detección): bitácora de seguridad. Aparte de event_logs (que se depura por cuenta y se borra con la cuenta):
-- lo que pasó en el acceso y con los datos se conserva un año aunque la cuenta o la persona ya no existan, para poder
-- reconstruir un incidente. Sin llaves foráneas por eso mismo. La escribe el backend y nunca la edita.
CREATE TABLE IF NOT EXISTS security_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (length(kind) <= 60),
  account_id  uuid,
  user_id     uuid,
  email       text NOT NULL DEFAULT '' CHECK (length(email) <= 200),
  ip          text NOT NULL DEFAULT '' CHECK (length(ip) <= 64),
  user_agent  text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 200),
  target      text NOT NULL DEFAULT '' CHECK (length(target) <= 200),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS security_events_at_idx ON security_events (at DESC);
CREATE INDEX IF NOT EXISTS security_events_account_idx ON security_events (account_id, at DESC);
CREATE INDEX IF NOT EXISTS security_events_kind_idx ON security_events (kind, at DESC);
CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events (user_id, at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_events_ip_idx ON security_events (ip, at DESC) WHERE ip <> '';
CREATE INDEX IF NOT EXISTS security_events_email_idx ON security_events (lower(email), at DESC) WHERE email <> '';

-- Avisos de detección ya enviados (uno por regla y objetivo cada hora, aunque haya varios procesos).
CREATE TABLE IF NOT EXISTS security_alerts (
  key         text PRIMARY KEY CHECK (length(key) <= 300),
  alerted_at  timestamptz NOT NULL DEFAULT now()
);
