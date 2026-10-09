-- Avisos internos enviados por WhatsApp (alertas al equipo). Su eco llega como mensaje propio del número conectado;
-- se reconoce aquí para que no cree contactos, conversaciones ni pausas falsas.
CREATE TABLE IF NOT EXISTS internal_notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS internal_notices_lookup_idx ON internal_notices(account_id, phone, content, created_at DESC);
