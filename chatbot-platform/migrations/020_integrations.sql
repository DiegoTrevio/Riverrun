-- Integraciones: llaves de API, webhooks de eventos (con bitácora de entregas) y Google Calendar.

-- Llaves de la API pública (/api/v1): solo se guarda el hash; el texto completo se muestra una vez al crearla.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,                 -- primeros caracteres, para reconocerla en la lista
  key_hash     text NOT NULL UNIQUE,          -- sha256 hex
  scope        text NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_account_idx ON api_keys (account_id);

-- Webhooks de eventos: el sistema avisa a la URL cuando pasa algo (contacto nuevo, cita, datos capturados…).
CREATE TABLE webhook_endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url                  text NOT NULL,
  description          text NOT NULL DEFAULT '',
  events               jsonb NOT NULL DEFAULT '["*"]'::jsonb,
  active               boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_reason      text NOT NULL DEFAULT '',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_account_idx ON webhook_endpoints (account_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id          bigserial PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL,
  event       text NOT NULL,
  ok          boolean NOT NULL,
  status_code integer,
  error       text NOT NULL DEFAULT '',
  attempt     integer NOT NULL DEFAULT 1,
  duration_ms integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, id DESC);

-- Google Calendar: las citas del asistente se reflejan como eventos del calendario de la cuenta.
CREATE TABLE google_calendar (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  google_email  text NOT NULL DEFAULT '',
  refresh_token text NOT NULL,                -- cifrado con la clave del servidor
  calendar_id   text NOT NULL DEFAULT 'primary',
  block_busy    boolean NOT NULL DEFAULT true, -- los eventos ocupados del calendario bloquean horarios de la agenda
  last_error    text NOT NULL DEFAULT '',
  connected_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE appointments ADD COLUMN google_event_id text;
