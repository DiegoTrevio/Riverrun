-- Subir el precio de un plan no debe marcar a los suscriptores que ya lo pagaban: el precio con el que se aceptó la
-- suscripción se guarda y, mientras el proveedor siga cobrando ese mismo precio, el plan se conserva aunque el monto
-- vigente del plan sea mayor. Stripe: el id del precio. Mercado Pago: «monto en centavos:moneda:meses».
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS accepted_price_ref text NOT NULL DEFAULT '';
