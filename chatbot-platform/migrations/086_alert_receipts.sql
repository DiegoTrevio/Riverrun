-- Cada entrega de un aviso al equipo por WhatsApp o correo queda registrada con su resultado: si falla se reintenta, en
-- los avisos urgentes se manda por el otro canal, y el panel muestra qué llegó y qué no.
CREATE TABLE alert_receipts (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- El aviso del panel de esa persona (si lo tiene en el panel).
  notification_id bigint REFERENCES notifications(id) ON DELETE CASCADE,
  -- NULL: un número externo (los de una regla), que no es del equipo.
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Las entregas del mismo aviso a la misma persona comparten esta clave (para el respaldo entre canales).
  alert_key       uuid NOT NULL,
  kind            text NOT NULL DEFAULT 'alert',
  channel         text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  destination     text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text NOT NULL DEFAULT '',
  -- La entrega de la que esta es el respaldo (el otro canal).
  fallback_of     bigint REFERENCES alert_receipts(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX alert_receipts_due_idx ON alert_receipts (next_attempt_at) WHERE status = 'pending';
CREATE INDEX alert_receipts_account_idx ON alert_receipts (account_id, created_at DESC);
CREATE INDEX alert_receipts_notification_idx ON alert_receipts (notification_id);
CREATE INDEX alert_receipts_user_idx ON alert_receipts (user_id, created_at DESC);
CREATE INDEX alert_receipts_key_idx ON alert_receipts (alert_key);
CREATE INDEX alert_receipts_fallback_idx ON alert_receipts (fallback_of);
