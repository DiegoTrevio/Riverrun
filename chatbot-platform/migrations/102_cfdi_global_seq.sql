-- CFDI global (PAY-22): un pago que llega después de emitida la global de su mes (reintento del aviso, conciliación)
-- quedaba sin factura para siempre, porque solo cabía una global por mes y forma de pago. El SAT permite varias del
-- mismo periodo: cada una lleva su número (seq) y la que llega tarde sale como la siguiente.
ALTER TABLE cfdi_invoices ADD COLUMN IF NOT EXISTS seq int NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS cfdi_invoices_one_global;
CREATE UNIQUE INDEX IF NOT EXISTS cfdi_invoices_global_seq ON cfdi_invoices (global_period, payment_form, seq) WHERE kind = 'global';
-- Una global del mes puede pasar de 21 millones de pesos.
ALTER TABLE cfdi_invoices ALTER COLUMN amount_cents TYPE bigint;
