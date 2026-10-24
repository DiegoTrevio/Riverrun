-- Cobro sin intervención: conciliación diaria con el proveedor, acciones con reintento (cancelar, reembolsar),
-- contracargos y pagos que el banco pide confirmar (3DS).

-- Última vez que la suscripción se comparó con el proveedor; enlace para confirmar un cobro que el banco detuvo.
ALTER TABLE subscriptions
  ADD COLUMN reconciled_at      timestamptz,
  ADD COLUMN payment_action_url text NOT NULL DEFAULT '';
CREATE INDEX subscriptions_reconcile_idx ON subscriptions (reconciled_at NULLS FIRST) WHERE provider_subscription_id <> '';

-- Lo que la plataforma tiene que hacer en el proveedor y reintenta hasta lograrlo: cancelar una suscripción (duplicada,
-- sustituida, sin pago o de una cuenta borrada) o reembolsar sus cobros (duplicada). Sobrevive al borrado de la cuenta.
CREATE TABLE billing_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL CHECK (provider IN ('stripe', 'mercadopago')),
  kind            text NOT NULL CHECK (kind IN ('cancel', 'refund_subscription')),
  ref             text NOT NULL CHECK (ref <> ''),
  account_id      uuid REFERENCES accounts(id) ON DELETE SET NULL,
  reason          text NOT NULL DEFAULT '' CHECK (reason IN ('', 'duplicate', 'replaced', 'unpaid', 'deleted', 'dispute')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, kind, ref)
);
CREATE INDEX billing_actions_due_idx ON billing_actions (next_attempt_at) WHERE status = 'pending';
CREATE INDEX billing_actions_account_idx ON billing_actions (account_id);

-- Contracargo (el cliente desconoció el cobro con su banco): abierto, ganado o perdido.
ALTER TABLE billing_payments
  ADD COLUMN dispute_status text NOT NULL DEFAULT '' CHECK (dispute_status IN ('', 'open', 'won', 'lost')),
  ADD COLUMN dispute_ref    text NOT NULL DEFAULT '';

-- Una cuenta con un contracargo abierto se pausa mientras se resuelve.
ALTER TABLE accounts DROP CONSTRAINT accounts_pause_reason_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_pause_reason_check CHECK (pause_reason IN ('', 'trial', 'payment', 'dispute'));
