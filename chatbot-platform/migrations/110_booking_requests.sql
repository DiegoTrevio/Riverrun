-- IN-18: la página pública de reservas ya no agenda al momento. Guarda la solicitud y manda un enlace al correo (texto
-- fijo, una hora, un solo uso); la cita se agenda (con su aviso al equipo, anticipo y calendario) al abrirlo. Sin correo
-- confirmado nadie llena la agenda ni usa el correo de la plataforma para mandar texto propio.
CREATE TABLE IF NOT EXISTS booking_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id       uuid NOT NULL REFERENCES booking_links(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email         text NOT NULL,
  email_key     text NOT NULL,
  payload       jsonb NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_requests_account_idx ON booking_requests (account_id, email_key) WHERE confirmed_at IS NULL;
CREATE INDEX IF NOT EXISTS booking_requests_link_idx ON booking_requests (link_id);
