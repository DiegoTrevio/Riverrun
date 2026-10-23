-- Agrupar avisos sin depender del panel: cada aviso entregado a una persona (por cualquier canal) deja su huella
-- (tipo, enlace y una firma del título y el texto). El mismo aviso no se repite en 10 minutos aunque la persona
-- solo lo reciba por WhatsApp o correo; uno distinto (otra cotización, otro motivo) sí llega.
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  link       text NOT NULL,
  digest     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_deliveries_lookup_idx ON alert_deliveries (user_id, kind, link, digest, created_at DESC);
CREATE INDEX IF NOT EXISTS alert_deliveries_created_idx ON alert_deliveries (created_at);

-- El índice de la 076 sobre notifications ya no se usa (y cuesta en cada aviso).
DROP INDEX IF EXISTS notifications_dedupe_idx;
