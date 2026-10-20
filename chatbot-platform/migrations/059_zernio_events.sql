-- Eventos del webhook de Zernio: cada uno se guarda una sola vez por su id (Zernio reintenta hasta 7 veces y un evento
-- capturado no se puede repetir) y lo que no es un mensaje se procesa después, para responder en menos de 5 s.
CREATE TABLE IF NOT EXISTS zernio_events (
  event_id          text PRIMARY KEY,
  event             text NOT NULL DEFAULT '',
  zernio_account_id text NOT NULL DEFAULT '',
  account_id        uuid REFERENCES accounts(id) ON DELETE CASCADE,
  payload           jsonb NOT NULL DEFAULT '{}',
  state             text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'dead', 'ignored')),
  attempts          int NOT NULL DEFAULT 0,
  lease_until       timestamptz,
  run_at            timestamptz NOT NULL DEFAULT now(),
  reason            text,
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zernio_events_due_idx ON zernio_events (run_at) WHERE state IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS zernio_events_account_idx ON zernio_events (account_id);
CREATE INDEX IF NOT EXISTS zernio_events_received_idx ON zernio_events (received_at);

-- Entregado y leído, según lo informe la red.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at timestamptz;
