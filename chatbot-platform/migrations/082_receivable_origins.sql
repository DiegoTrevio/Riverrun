-- Cobros que se crean solos: pagos recurrentes, anticipo de una cita y desde una cotización que el cliente aceptó.

-- Ningún origen duplica su cobro aunque su tarea corra dos veces: un plan por periodo, una cita, una parcialidad, o un
-- reintento del ERP con su mismo folio. Un cobro manual no lleva folio de origen.
DROP INDEX IF EXISTS receivables_api_source_idx;
CREATE UNIQUE INDEX IF NOT EXISTS receivables_source_idx ON receivables (account_id, source, source_id) WHERE source <> 'manual' AND source_id <> '';
-- «2 de 3» en los pagos en parcialidades.
ALTER TABLE receivables ADD COLUMN IF NOT EXISTS installment text NOT NULL DEFAULT '' CHECK (length(installment) <= 20);

-- Pago recurrente: cada periodo se crea el cobro unos días antes de que venza.
CREATE TABLE IF NOT EXISTS receivable_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  concept text NOT NULL CHECK (length(concept) BETWEEN 1 AND 200),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  currency text NOT NULL DEFAULT 'MXN' CHECK (currency ~ '^[A-Z]{3}$'),
  payment_link text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  reminders jsonb CHECK (reminders IS NULL OR jsonb_typeof(reminders) = 'array'),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
  -- Semanal y quincenal: día de la semana (0 = domingo). Mensual: día del mes (31 = el último en meses cortos).
  day integer NOT NULL CHECK (day BETWEEN 0 AND 31),
  starts_on date NOT NULL,
  ends_on date,
  max_payments integer CHECK (max_payments IS NULL OR max_payments BETWEEN 1 AND 600),
  payments_created integer NOT NULL DEFAULT 0,
  -- Último vencimiento ya creado: el siguiente se calcula desde aquí.
  last_due date,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (frequency = 'monthly' AND day BETWEEN 1 AND 31 OR frequency <> 'monthly' AND day BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS receivable_plans_account_idx ON receivable_plans (account_id, active);
CREATE INDEX IF NOT EXISTS receivable_plans_contact_idx ON receivable_plans (contact_id);
CREATE INDEX IF NOT EXISTS receivable_plans_conversation_idx ON receivable_plans (conversation_id);
CREATE INDEX IF NOT EXISTS receivable_plans_created_by_idx ON receivable_plans (created_by);

-- Anticipo de una cita: un monto fijo por servicio, que vence unas horas antes de la cita (0 = el día que se agenda).
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_cents bigint NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0 AND deposit_cents <= 100000000000);
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_currency text NOT NULL DEFAULT 'MXN' CHECK (deposit_currency ~ '^[A-Z]{3}$');
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_due_hours integer NOT NULL DEFAULT 0 CHECK (deposit_due_hours BETWEEN 0 AND 720);
-- Si el anticipo no se pagó a la hora límite, la cita se cancela sola (apagado por defecto).
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_cancel_unpaid boolean NOT NULL DEFAULT false;

-- Cotización aceptada por el cliente (la marca el equipo): ya no vence y de ella salen sus cobros.
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'failed'));
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS quotes_accepted_by_idx ON quotes (accepted_by);
