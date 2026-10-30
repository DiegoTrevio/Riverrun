-- Subir de plan en Mercado Pago: el monto nuevo se cobra en la siguiente renovación (Mercado Pago no cobra la diferencia),
-- así que el plan nuevo y sus límites empiezan con ese cobro. Mientras tanto queda aquí, programado.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan_key text NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan_since timestamptz;
-- El monto que se pactó con el proveedor: con ese cobro empieza, aunque después cambie el precio del plan.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_amount_cents integer NOT NULL DEFAULT 0;
