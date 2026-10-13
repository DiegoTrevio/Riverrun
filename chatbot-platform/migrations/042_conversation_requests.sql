-- Solicitudes dentro de una conversación: el cliente puede volver a pedir lo mismo (otra reserva, el mismo problema,
-- la misma pregunta) y se le atiende de nuevo. Cada solicitud guarda cuándo empezó y terminó, por qué empezó, si se
-- cumplió su objetivo y las respuestas que se vuelven a preguntar en cada una.
CREATE TABLE IF NOT EXISTS conversation_requests (
  id                bigserial PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  number            integer NOT NULL,
  reason            text NOT NULL DEFAULT 'inicio',
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  goal_completed_at timestamptz,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (conversation_id, number)
);
