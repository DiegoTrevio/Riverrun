-- Último pago iniciado por cada cuenta (sesión de Stripe o suscripción pendiente de Mercado Pago). Con esta referencia el
-- sistema confirma el pago consultando al proveedor al volver del pago y en la revisión periódica: la cuenta se activa
-- aunque el aviso (webhook) se retrase o no esté bien configurado.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS checkout_provider text NOT NULL DEFAULT '' CHECK (checkout_provider IN ('', 'stripe', 'mercadopago')),
  ADD COLUMN IF NOT EXISTS checkout_ref      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS checkout_at       timestamptz;
CREATE INDEX IF NOT EXISTS subscriptions_pending_checkout_idx ON subscriptions (checkout_at) WHERE checkout_ref <> '';
