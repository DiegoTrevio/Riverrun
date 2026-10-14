-- Outlook (Microsoft 365 / Outlook.com): como Google Calendar, las citas de la agenda se reflejan como eventos del
-- calendario de la cuenta y, si se elige, sus horarios ocupados no se ofrecen a los clientes.
CREATE TABLE IF NOT EXISTS outlook_calendar (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email         text NOT NULL DEFAULT '',
  refresh_token text NOT NULL,                -- cifrado con la clave del servidor
  block_busy    boolean NOT NULL DEFAULT true, -- los eventos ocupados del calendario bloquean horarios de la agenda
  last_error    text NOT NULL DEFAULT '',
  connected_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS outlook_event_id text;
