-- Historial de incidencias de la plataforma (no de los clientes). Una incidencia abierta por componente: si el mismo
-- componente vuelve a fallar mientras sigue abierta, se actualiza en vez de duplicarse. Nunca guarda contenido de
-- mensajes ni datos personales: solo el nombre del componente y el resumen que ya muestra el panel.
CREATE TABLE IF NOT EXISTS incidents (
  id           bigserial PRIMARY KEY,
  component    text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('critica', 'alta', 'media', 'baja')),
  state        text NOT NULL CHECK (state IN ('abierto', 'resuelto')),
  title        text NOT NULL,
  detail       text NOT NULL DEFAULT '',
  opened_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  escalated_at timestamptz,
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open_per_component ON incidents (component) WHERE state = 'abierto';
CREATE INDEX IF NOT EXISTS incidents_opened_at ON incidents (opened_at DESC);
