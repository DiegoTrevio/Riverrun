-- Ningún cliente sin respuesta: una conversación que falló se reintenta sola (revivals cuenta los reintentos
-- automáticos) y, mientras siga esperando, se vuelve a avisar al equipo (alerted_at: último aviso).
ALTER TABLE conversation_work ADD COLUMN IF NOT EXISTS revivals integer NOT NULL DEFAULT 0;
ALTER TABLE conversation_work ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
