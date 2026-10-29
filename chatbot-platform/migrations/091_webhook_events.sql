-- Webhooks: el cuerpo de cada evento se guarda una vez (30 días, como la bitácora de entregas). Cada intento lo lee de
-- aquí, se puede ver desde «Ver entregas» y reenviar si tu sistema lo perdió. Al borrar los datos de un cliente se
-- borran también sus eventos.
CREATE TABLE webhook_events (
  id         uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type       text NOT NULL,
  body       json NOT NULL,                  -- json (no jsonb): se entrega tal cual se armó, con sus campos en orden
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_account_idx ON webhook_events (account_id, created_at);
CREATE INDEX webhook_events_created_idx ON webhook_events (created_at);
