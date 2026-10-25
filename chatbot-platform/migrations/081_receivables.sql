-- Cobros de cada negocio a sus clientes: lo que le deben (un servicio, una cuota, un anticipo) y los recordatorios de
-- pago por WhatsApp. El dinero no pasa por la plataforma: el cliente paga con las instrucciones del negocio y el equipo
-- marca el cobro como pagado.
CREATE TABLE IF NOT EXISTS receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  concept text NOT NULL CHECK (length(concept) BETWEEN 1 AND 200),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  currency text NOT NULL DEFAULT 'MXN' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Día de vencimiento en la zona del negocio.
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled')),
  paid_at timestamptz,
  paid_by uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_note text NOT NULL DEFAULT '',
  -- Enlace de pago de este cobro (opcional; si no, van las instrucciones de la cuenta).
  payment_link text NOT NULL DEFAULT '',
  -- Folio o referencia del negocio (lo que el cliente pone en su transferencia).
  reference text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'api', 'recurring', 'appointment', 'quote')),
  source_id text NOT NULL DEFAULT '',
  -- Días respecto al vencimiento (negativo = antes). NULL: los de la cuenta.
  reminders jsonb CHECK (reminders IS NULL OR jsonb_typeof(reminders) = 'array'),
  reminders_sent integer NOT NULL DEFAULT 0,
  last_reminded_at timestamptz,
  -- El cliente dijo que ya pagó o mandó su comprobante: no se le insiste mientras el equipo lo verifica.
  paused_until timestamptz,
  overdue_notified_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receivables_account_status_idx ON receivables (account_id, status, due_date);
CREATE INDEX IF NOT EXISTS receivables_contact_idx ON receivables (contact_id);
CREATE INDEX IF NOT EXISTS receivables_conversation_idx ON receivables (conversation_id);
CREATE INDEX IF NOT EXISTS receivables_paid_by_idx ON receivables (paid_by);
CREATE INDEX IF NOT EXISTS receivables_created_by_idx ON receivables (created_by);

CREATE TABLE IF NOT EXISTS receivable_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Cómo pagar: CLABE, enlace fijo de Mercado Pago o Stripe, pago en sucursal…
  payment_instructions text NOT NULL DEFAULT '',
  default_reminders jsonb NOT NULL DEFAULT '[-3, 0, 3, 7]' CHECK (jsonb_typeof(default_reminders) = 'array'),
  send_at text NOT NULL DEFAULT '10:00' CHECK (send_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  respect_business_hours boolean NOT NULL DEFAULT true,
  message_before text NOT NULL DEFAULT '',
  message_due text NOT NULL DEFAULT '',
  message_overdue text NOT NULL DEFAULT '',
  -- WhatsApp oficial: plantilla aprobada para cuando el cliente no escribió en las últimas 24 h.
  wa_template jsonb,
  notify_team_on_overdue boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
