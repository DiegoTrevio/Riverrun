-- Facturas electrónicas (CFDI 4.0) de los cobros: una por pago de quien pidió factura, una global al mes (por forma de
-- pago) con los pagos sin factura, y las notas de crédito de los reembolsos. Cada CFDI guarda la copia de los datos con
-- que se emitió. Se conservan aunque se borre la cuenta (son contabilidad), igual que los pagos.
CREATE TABLE cfdi_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('payment', 'global', 'credit')),
  account_id          uuid REFERENCES accounts(id) ON DELETE SET NULL,
  -- Pago facturado (payment) o reembolsado (credit).
  payment_id          uuid REFERENCES billing_payments(id) ON DELETE SET NULL,
  -- Nota de crédito: el CFDI que corrige.
  related_id          uuid REFERENCES cfdi_invoices(id) ON DELETE SET NULL,
  -- Global: mes (AAAA-MM, hora de México) y forma de pago del SAT.
  global_period       text NOT NULL DEFAULT '',
  payment_form        text NOT NULL DEFAULT '',
  amount_cents        integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  receiver            jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'failed', 'void')),
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text NOT NULL DEFAULT '',
  -- El PAC rechazó los datos del receptor (se reintenta al corregirlos), a diferencia de una falla del servicio.
  data_error          boolean NOT NULL DEFAULT false,
  provider_invoice_id text NOT NULL DEFAULT '',
  sat_uuid            text NOT NULL DEFAULT '',
  series              text NOT NULL DEFAULT '',
  folio               text NOT NULL DEFAULT '',
  issued_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cfdi_invoices_account_idx ON cfdi_invoices (account_id);
CREATE INDEX cfdi_invoices_payment_idx ON cfdi_invoices (payment_id);
CREATE INDEX cfdi_invoices_related_idx ON cfdi_invoices (related_id);
CREATE INDEX cfdi_invoices_due_idx ON cfdi_invoices (next_attempt_at) WHERE status = 'pending';
CREATE UNIQUE INDEX cfdi_invoices_one_per_payment ON cfdi_invoices (payment_id) WHERE kind = 'payment';
CREATE UNIQUE INDEX cfdi_invoices_one_global ON cfdi_invoices (global_period, payment_form) WHERE kind = 'global';

-- Pagos sin factura propia: la global del mes en que entraron. invoiced_cents: lo que quedó facturado (el pago menos lo
-- reembolsado al emitir); un reembolso posterior lleva nota de crédito por la diferencia.
ALTER TABLE billing_payments
  ADD COLUMN global_cfdi_id uuid REFERENCES cfdi_invoices(id) ON DELETE SET NULL,
  ADD COLUMN invoiced_cents integer NOT NULL DEFAULT 0 CHECK (invoiced_cents >= 0);
CREATE INDEX billing_payments_global_cfdi_idx ON billing_payments (global_cfdi_id);
