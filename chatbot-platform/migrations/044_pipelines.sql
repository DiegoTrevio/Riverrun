-- Pipelines (embudos): columnas que el negocio define (Nuevo → Interesado → Cotizado → Ganado / Perdido) y por las que
-- cada solicitud de un cliente avanza sola según lo que pasa en la conversación (o a mano desde el tablero).
-- Una cuenta puede tener varios; cada agente usa a lo más uno (chatbot_ids).
CREATE TABLE IF NOT EXISTS pipelines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           text NOT NULL,
  -- [{ id, name, kind: open|won|lost, color, when, events: [...] }]
  stages         jsonb NOT NULL DEFAULT '[]'::jsonb,
  chatbot_ids    uuid[] NOT NULL DEFAULT '{}',
  -- Si la IA o un evento pueden regresar una tarjeta a una columna anterior (a mano siempre se puede).
  allow_backward boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipelines_account_idx ON pipelines (account_id);

-- Una tarjeta por solicitud: cuando el cliente vuelve por otra, la anterior se cierra y empieza una nueva.
CREATE TABLE IF NOT EXISTS pipeline_cards (
  id               bigserial PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pipeline_id      uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_number   integer NOT NULL DEFAULT 1,
  stage_id         text NOT NULL,
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS pipeline_cards_account_idx ON pipeline_cards (account_id);
CREATE INDEX IF NOT EXISTS pipeline_cards_pipeline_idx ON pipeline_cards (pipeline_id, stage_id);
CREATE INDEX IF NOT EXISTS pipeline_cards_conversation_idx ON pipeline_cards (conversation_id);
-- Solo una tarjeta abierta por conversación.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_cards_open_idx ON pipeline_cards (conversation_id) WHERE closed_at IS NULL;

-- Historial de cada tarjeta: de dónde a dónde, por qué y quién (la IA, un evento o una persona).
CREATE TABLE IF NOT EXISTS pipeline_moves (
  id         bigserial PRIMARY KEY,
  card_id    bigint NOT NULL REFERENCES pipeline_cards(id) ON DELETE CASCADE,
  from_stage text,
  to_stage   text NOT NULL,
  source     text NOT NULL,
  reason     text NOT NULL DEFAULT '',
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_moves_card_idx ON pipeline_moves (card_id);
CREATE INDEX IF NOT EXISTS pipeline_moves_user_idx ON pipeline_moves (user_id);
