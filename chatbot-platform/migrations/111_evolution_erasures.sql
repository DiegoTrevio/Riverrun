-- INF-8: el borrado de un contacto también llega a la base de Evolution (que guarda cada mensaje de WhatsApp). El backend
-- ya no entra a esa base (INF-2): deja aquí la solicitud y el contenedor de respaldos (superusuario, cada hora) borra
-- los mensajes de esa conversación en Evolution y la marca como hecha. También aplica ahí la retención de mensajes.
CREATE TABLE IF NOT EXISTS evolution_erasures (
  id           bigserial PRIMARY KEY,
  instance     text NOT NULL,
  jids         text[] NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  deleted      integer
);
CREATE INDEX IF NOT EXISTS evolution_erasures_pending_idx ON evolution_erasures (requested_at) WHERE done_at IS NULL;
