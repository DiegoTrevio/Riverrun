-- Recordatorios para que nada quede desatendido.
-- down_since: desde cuándo está caído un canal que estaba conectado (vacío si está en línea o se desconectó a propósito).
-- disconnect_notified_at: último aviso de desconexión (se vuelve a avisar cada 6 h).
-- human_reminded_at: último recordatorio de un cliente que espera a una persona (cada 2 h).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS down_since timestamptz;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disconnect_notified_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS human_reminded_at timestamptz;
-- WhatsApp que ya estaban caídos al instalar esta versión (en las últimas 24 h): se siguen vigilando.
UPDATE channels SET down_since = connection_state_at
 WHERE type = 'whatsapp' AND connection_state = 'close' AND down_since IS NULL AND connection_state_at > now() - interval '24 hours';
