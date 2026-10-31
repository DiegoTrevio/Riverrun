-- Disputas (PAY-4, PAY-5): manda lo que dice el proveedor, los cobros se detienen mientras la disputa está abierta y una
-- disputa perdida deja la cuenta en pausa hasta que el dueño pague con otra tarjeta.
--   * accounts.pause_reason 'dispute_lost': perdió una disputa (o hubo alerta de fraude); solo otra tarjeta la reactiva.
--   * billing_actions: detener y reanudar los cobros de la suscripción, y reembolsar un cobro (alerta de fraude).
--   * billing_payments.dispute_checked_at: cuándo se releyó la disputa del proveedor.
--   * subscriptions.collection_paused: los cobros los detuvo Riverrun por una disputa (no es un pago pendiente).
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_pause_reason_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_pause_reason_check CHECK (pause_reason IN ('', 'trial', 'payment', 'dispute', 'dispute_lost', 'card', 'manual'));

ALTER TABLE billing_actions DROP CONSTRAINT IF EXISTS billing_actions_kind_check;
ALTER TABLE billing_actions ADD CONSTRAINT billing_actions_kind_check
  CHECK (kind IN ('cancel', 'refund_subscription', 'refund_charge', 'pause_collection', 'resume_collection'));
ALTER TABLE billing_actions DROP CONSTRAINT IF EXISTS billing_actions_reason_check;
ALTER TABLE billing_actions ADD CONSTRAINT billing_actions_reason_check
  CHECK (reason IN ('', 'duplicate', 'replaced', 'unpaid', 'deleted', 'dispute', 'fraud_warning'));

ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS dispute_checked_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS collection_paused boolean NOT NULL DEFAULT false;
