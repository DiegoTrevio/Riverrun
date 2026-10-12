-- Reglas «solo una vez por conversación» (p. ej. avisos al equipo por un contexto que la IA detecta en varios mensajes).
-- Se cuenta por recorrido: si la conversación se reinicia o se reabre, la regla puede volver a dispararse.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS once_per_conversation boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS automation_conversation_runs (
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  journey         timestamptz NOT NULL DEFAULT 'epoch',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, conversation_id, journey)
);
CREATE INDEX IF NOT EXISTS automation_conversation_runs_conversation_idx ON automation_conversation_runs (conversation_id);
