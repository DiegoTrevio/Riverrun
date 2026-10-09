-- Límites reales por plan: mensajes del asistente al mes, canales, usuarios y asistentes.
-- NULL / clave ausente = sin límite. El superadmin puede dar excepciones por cuenta (limits_override).
ALTER TABLE plans    ADD COLUMN limits          jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounts ADD COLUMN limits_override jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Para avisar una sola vez por mes al llegar al 80 % y al 100 %: { "messages_80": "2026-10", "messages_100": "2026-10" }
ALTER TABLE accounts ADD COLUMN limit_notices   jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Contador mensual de mensajes enviados por el asistente y las automatizaciones (O(1) por consulta).
CREATE TABLE usage_counters (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month      text NOT NULL,             -- 'AAAA-MM' (UTC)
  messages   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);
