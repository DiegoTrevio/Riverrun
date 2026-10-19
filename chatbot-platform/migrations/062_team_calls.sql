-- Llamadas con el equipo: telefónica (la persona le marca al cliente) o videollamada (con enlace de Google Meet o Teams
-- desde el calendario de la persona, o su enlace fijo). Cómo se reparten, además de por turnos o porcentajes:
-- primero con quien ya atiende al cliente, y con la persona que el cliente pida.
ALTER TABLE services ADD COLUMN IF NOT EXISTS call_mode text NOT NULL DEFAULT 'phone';
DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_call_mode CHECK (call_mode IN ('phone', 'video'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE services ADD COLUMN IF NOT EXISTS prefer_owner boolean NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS customer_choice boolean NOT NULL DEFAULT false;

-- Enlace fijo de videollamada de cada persona (Zoom, Meet personal…), si no tiene calendario conectado.
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS meeting_url text NOT NULL DEFAULT '';

-- Enlace de la videollamada de la cita y correo del cliente (reservas desde la página pública).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS meeting_url text NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS customer_email text NOT NULL DEFAULT '';

-- Enlaces públicos para reservar (como Calendly): del negocio (varios servicios) o de una persona.
CREATE TABLE IF NOT EXISTS booking_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  name        text NOT NULL,
  service_ids uuid[] NOT NULL DEFAULT '{}',
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_links_account_idx ON booking_links (account_id);
CREATE INDEX IF NOT EXISTS booking_links_user_idx ON booking_links (user_id);
