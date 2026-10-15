-- Por qué se desconectó un WhatsApp: decide si se puede reconectar solo o hay que volver a escanear el QR.
-- logged_out: se cerró la sesión desde el teléfono; banned: WhatsApp bloqueó el número; replaced: la sesión se abrió en
-- otro lugar; connection_lost: se perdió la conexión (se reconecta sola). Vacío mientras está conectado.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disconnect_reason text NOT NULL DEFAULT '';
