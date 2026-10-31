-- CFDI en la moneda del cobro (PAY-9): un pago que no es en pesos se factura en su moneda con el tipo de cambio del
-- movimiento de saldo de Stripe; si no hay uno confiable, la factura queda «pendiente: tipo de cambio» (hold) hasta que
-- el superadministrador lo capture. La global del mes agrupa por moneda y tasa de IVA.
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS exchange_rate numeric(18, 6) CHECK (exchange_rate IS NULL OR exchange_rate > 0);
ALTER TABLE cfdi_invoices ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'MXN';
ALTER TABLE cfdi_invoices ADD COLUMN IF NOT EXISTS tax_percent numeric(5, 2);
ALTER TABLE cfdi_invoices ADD COLUMN IF NOT EXISTS hold text NOT NULL DEFAULT '' CHECK (hold IN ('', 'exchange_rate'));
DROP INDEX IF EXISTS cfdi_invoices_global_seq;
CREATE UNIQUE INDEX IF NOT EXISTS cfdi_invoices_global_seq ON cfdi_invoices (global_period, payment_form, currency, coalesce(tax_percent, -1), seq) WHERE kind = 'global';
