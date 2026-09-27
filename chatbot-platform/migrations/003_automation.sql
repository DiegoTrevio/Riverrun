-- Automatización: reglas, secuencias, campañas, agenda de citas/llamadas, alertas y tareas programadas.

-- Configuración general de la cuenta (zona horaria, horario, bajas, calendario...)
ALTER TABLE accounts ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Miembros del equipo: teléfono para recibir alertas por WhatsApp
ALTER TABLE users ADD COLUMN phone text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN notify_whatsapp boolean NOT NULL DEFAULT false;

-- Segmentación y bajas
ALTER TABLE contacts ADD COLUMN tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE contacts ADD COLUMN opted_out boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN opted_out_at timestamptz;
CREATE INDEX contacts_tags_idx ON contacts USING gin (tags);

-- Reglas automáticas: disparador + condiciones + acciones
CREATE TABLE automations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chatbot_id  uuid REFERENCES chatbots(id) ON DELETE CASCADE,   -- null = todos los chatbots de la cuenta
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  trigger     jsonb NOT NULL,
  conditions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  stop_ai     boolean NOT NULL DEFAULT false,                   -- si coincide, la IA no responde ese mensaje
  priority    integer NOT NULL DEFAULT 0,
  run_count   integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automations_account_idx ON automations (account_id) WHERE active;

-- Secuencias (flujos programados de varios mensajes)
CREATE TABLE sequences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                text NOT NULL,
  active              boolean NOT NULL DEFAULT true,
  steps               jsonb NOT NULL DEFAULT '[]'::jsonb,
  stop_on_reply       boolean NOT NULL DEFAULT true,
  business_hours_only boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sequence_id     uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped')),
  current_step    integer NOT NULL DEFAULT 0,
  last_inbound_id bigint NOT NULL DEFAULT 0,   -- para detectar si el cliente respondió
  stop_reason     text NOT NULL DEFAULT '',
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_step_at    timestamptz,
  next_run_at     timestamptz,
  finished_at     timestamptz
);
CREATE UNIQUE INDEX sequence_enrollments_active_idx ON sequence_enrollments (sequence_id, conversation_id) WHERE status = 'active';
CREATE INDEX sequence_enrollments_conversation_idx ON sequence_enrollments (conversation_id);

-- Tareas programadas (duraderas: sobreviven a reinicios)
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text NOT NULL DEFAULT '',
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'pending';
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;

-- Campañas (envíos programados a un segmento)
CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name            text NOT NULL,
  message         text NOT NULL DEFAULT '',
  image_id        uuid REFERENCES images(id) ON DELETE SET NULL,
  audience        jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at    timestamptz,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  rate_per_minute integer NOT NULL DEFAULT 20,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_account_idx ON campaigns (account_id, created_at DESC);

CREATE TABLE campaign_recipients (
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  reason          text NOT NULL DEFAULT '',
  sent_at         timestamptz,
  PRIMARY KEY (campaign_id, conversation_id)
);

-- Agenda: servicios (citas o llamadas) y citas
CREATE TABLE services (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'appointment' CHECK (kind IN ('appointment', 'call')),
  description        text NOT NULL DEFAULT '',
  duration_minutes   integer NOT NULL DEFAULT 30,
  buffer_minutes     integer NOT NULL DEFAULT 0,
  capacity           integer NOT NULL DEFAULT 1,
  min_notice_minutes integer NOT NULL DEFAULT 60,
  max_days_ahead     integer NOT NULL DEFAULT 30,
  location           text NOT NULL DEFAULT '',
  hours              jsonb,                                   -- null = horario de la cuenta
  reminders          jsonb NOT NULL DEFAULT '[1440, 60]'::jsonb, -- minutos antes
  reminder_message   text NOT NULL DEFAULT '',
  assigned_user_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  notify_team        boolean NOT NULL DEFAULT true,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_account_idx ON services (account_id);

CREATE TABLE appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  service_id       uuid REFERENCES services(id) ON DELETE SET NULL,
  service_name     text NOT NULL DEFAULT '',
  kind             text NOT NULL DEFAULT 'appointment',
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  customer_name    text NOT NULL DEFAULT '',
  customer_phone   text NOT NULL DEFAULT '',
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  source           text NOT NULL DEFAULT 'bot',
  notes            text NOT NULL DEFAULT '',
  cancel_reason    text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_account_time_idx ON appointments (account_id, starts_at);
CREATE INDEX appointments_service_time_idx ON appointments (service_id, starts_at) WHERE status = 'confirmed';
CREATE INDEX appointments_contact_idx ON appointments (contact_id);

-- Notificaciones internas del panel (una por usuario)
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'alert',
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  link       text NOT NULL DEFAULT '',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
