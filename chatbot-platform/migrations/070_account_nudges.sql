-- Correos de seguimiento del alta (conectar WhatsApp, probar el agente, reactivar): cada uno sale una sola vez por cuenta.
-- La fila se reserva antes de enviar, así dos procesos no mandan el mismo correo.
CREATE TABLE account_nudges (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('connect', 'test', 'reactivate')),
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind)
);
