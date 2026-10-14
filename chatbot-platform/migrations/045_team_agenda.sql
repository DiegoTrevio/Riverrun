-- Agenda del equipo: varias personas por servicio, repartidas por turnos (round robin) o por porcentajes; cada persona
-- con su horario, sus días libres y su propio calendario (Google u Outlook).

-- Cómo se reparten las citas entre las personas del servicio. Con personas asignadas, «capacity» es cuántas citas puede
-- atender cada persona al mismo tiempo (1 = una a la vez); sin personas, cuántas caben al mismo tiempo en el servicio.
ALTER TABLE services ADD COLUMN IF NOT EXISTS assignment_mode text NOT NULL DEFAULT 'round_robin';
ALTER TABLE services ADD COLUMN IF NOT EXISTS user_weights jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_assignment_mode CHECK (assignment_mode IN ('round_robin', 'weighted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Disponibilidad de cada persona: horario semanal (null = el del negocio) y días libres [{ from, to, note }].
CREATE TABLE IF NOT EXISTS staff_schedules (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hours      jsonb,
  time_off   jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_schedules_account_idx ON staff_schedules (account_id);

-- Calendario propio de cada persona: sus eventos ocupados bloquean sus horarios y sus citas se copian ahí.
CREATE TABLE IF NOT EXISTS staff_calendars (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('google', 'outlook')),
  email         text NOT NULL DEFAULT '',
  refresh_token text NOT NULL,                  -- cifrado con la clave del servidor
  calendar_id   text NOT NULL DEFAULT 'primary',
  block_busy    boolean NOT NULL DEFAULT true,
  last_error    text NOT NULL DEFAULT '',
  connected_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_calendars_account_idx ON staff_calendars (account_id);

-- Evento de la cita en el calendario de la persona asignada (y de quién es: si se reasigna, se quita del anterior).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_event_id text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_event_provider text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_event_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS appointments_staff_event_user_idx ON appointments (staff_event_user_id);
CREATE INDEX IF NOT EXISTS appointments_assigned_user_idx ON appointments (assigned_user_id, starts_at) WHERE status = 'confirmed';
