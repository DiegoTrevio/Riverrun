-- Mensajes guardados del asistente (texto y foto opcional que se envían tal cual) y
-- etapa del recorrido en la que queda la conversación cuando una campaña envía el primer mensaje.
-- Idempotente: una base que ya corrió una versión anterior de este cambio no falla.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS saved_messages jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chatbots_saved_messages_array') THEN
    ALTER TABLE chatbots ADD CONSTRAINT chatbots_saved_messages_array CHECK (jsonb_typeof(saved_messages) = 'array');
  END IF;
END $$;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS flow_step integer NOT NULL DEFAULT 0 CHECK (flow_step >= 0 AND flow_step <= 50);
