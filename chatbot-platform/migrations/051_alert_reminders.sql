-- Recordatorios para que nada quede desatendido: WhatsApp que sigue desconectado (se vuelve a avisar cada 6 h) y
-- clientes que esperan a una persona del equipo (se recuerda cada 2 h).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disconnect_notified_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS human_reminded_at timestamptz;
