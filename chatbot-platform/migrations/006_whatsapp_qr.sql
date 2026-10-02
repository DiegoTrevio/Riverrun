-- Conexión de WhatsApp: último QR / código de vinculación generado (se borran al conectar).
-- Nunca se envían en el listado de canales; solo los devuelve la sesión de conexión.
ALTER TABLE channels
  ADD COLUMN qr_code        text,
  ADD COLUMN qr_at          timestamptz,
  ADD COLUMN pairing_code   text,
  ADD COLUMN pairing_number text,
  ADD COLUMN pairing_at     timestamptz;
