-- Avisos de cobro que se pueden reprocesar: un aviso se reserva al llegar (claimed_at) y solo se da por hecho al terminar
-- (processed_at). Si el proceso muere a la mitad, el reintento del proveedor lo vuelve a procesar.
ALTER TABLE billing_events ADD COLUMN processed_at timestamptz;
ALTER TABLE billing_events ADD COLUMN claimed_at timestamptz;
-- Quién lo reservó: solo ese proceso lo puede dar por terminado o liberar (otro pudo retomarlo si tardó demasiado).
ALTER TABLE billing_events ADD COLUMN claim_token uuid;
-- Los que ya estaban se procesaron (antes, uno que fallaba se borraba).
UPDATE billing_events SET processed_at = received_at;
-- Lo que inserte una réplica con el código anterior (durante el despliegue) cuenta como procesado, como antes; el código
-- nuevo inserta NULL a propósito al reservar.
ALTER TABLE billing_events ALTER COLUMN processed_at SET DEFAULT now();
-- Para la alerta de avisos que quedaron sin procesar.
CREATE INDEX billing_events_unprocessed_idx ON billing_events (received_at) WHERE processed_at IS NULL;
