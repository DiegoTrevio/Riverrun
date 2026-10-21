-- Cada cobro que confirma el proveedor (Stripe o Mercado Pago), con el IVA desglosado. Es la base de las facturas (CFDI)
-- y del historial de pagos que ve el cliente. Un aviso repetido no duplica el pago: (proveedor, id del pago) es único.
-- Si se borra la cuenta, el pago se conserva (es contabilidad) sin la cuenta.
CREATE TABLE billing_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid REFERENCES accounts(id) ON DELETE SET NULL,
  provider            text NOT NULL CHECK (provider IN ('stripe', 'mercadopago')),
  -- Factura de Stripe (in_…) o pago autorizado de Mercado Pago.
  provider_payment_id text NOT NULL,
  -- Cargo con el que el proveedor informa reembolsos (cargo o intento de pago de Stripe, pago de Mercado Pago).
  provider_charge_ref text NOT NULL DEFAULT '',
  subscription_id     text NOT NULL DEFAULT '',
  plan_key            text NOT NULL DEFAULT '',
  currency            text NOT NULL,
  total_cents         integer NOT NULL CHECK (total_cents > 0),
  subtotal_cents      integer NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents           integer NOT NULL CHECK (tax_cents >= 0),
  tax_percent         numeric(5,2) NOT NULL,
  refunded_cents      integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  status              text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'partially_refunded', 'refunded')),
  paid_at             timestamptz NOT NULL,
  period_start        timestamptz,
  period_end          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id),
  CHECK (subtotal_cents + tax_cents = total_cents),
  CHECK (refunded_cents <= total_cents)
);
CREATE INDEX billing_payments_account_idx ON billing_payments (account_id, paid_at DESC);
CREATE INDEX billing_payments_charge_idx ON billing_payments (provider, provider_charge_ref) WHERE provider_charge_ref <> '';

-- Periodo de cobro del plan: mensual o anual.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year'));
