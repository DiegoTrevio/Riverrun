-- La biblioteca de cada agente ya no es solo de fotos: también videos, documentos (PDF, Office, CSV) y audio, que la IA
-- elige por contexto igual que las fotos. file_name = nombre con que llega el archivo al cliente.
ALTER TABLE images ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'video', 'document', 'audio'));
ALTER TABLE images ADD COLUMN IF NOT EXISTS file_name text NOT NULL DEFAULT '';

-- Lo que manda el cliente: también se guardan videos y audios. ai_summary = lo que la IA entendió de la foto o el documento
-- (qué es y su texto importante); se calcula una sola vez y es lo que el asistente lee en la conversación.
ALTER TABLE message_media DROP CONSTRAINT IF EXISTS message_media_kind_check;
ALTER TABLE message_media ADD CONSTRAINT message_media_kind_check CHECK (kind IN ('image', 'document', 'video', 'audio'));
ALTER TABLE message_media ADD COLUMN IF NOT EXISTS ai_summary text NOT NULL DEFAULT '';
