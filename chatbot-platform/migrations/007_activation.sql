-- Activadores y desactivadores del asistente, por conversación.
-- Es una capa aparte del estado (bot/humano/cerrada): el asistente en pausa no contesta,
-- pero la conversación no queda esperando a una persona.
ALTER TABLE conversations
  ADD COLUMN agent_off_at     timestamptz,
  ADD COLUMN agent_off_reason text NOT NULL DEFAULT '',
  ADD COLUMN agent_off_until  timestamptz,
  ADD COLUMN agent_on_at      timestamptz;  -- cuándo lo encendió una palabra de activación

CREATE INDEX IF NOT EXISTS event_logs_conversation_idx ON event_logs (conversation_id, id);
