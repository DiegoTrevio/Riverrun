-- Subir de plan en Mercado Pago: el monto nuevo se cobra en la siguiente renovación (Mercado Pago no cobra la diferencia),
-- así que el plan nuevo y sus límites empiezan con ese cobro. Mientras tanto queda aquí, programado.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan_key text NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan_since timestamptz;
