-- Mensajes guardados del asistente (texto y foto opcional que se envían tal cual) y
-- etapa del recorrido en la que queda la conversación cuando una campaña envía el primer mensaje.
ALTER TABLE chatbots ADD COLUMN saved_messages jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chatbots ADD CONSTRAINT chatbots_saved_messages_array CHECK (jsonb_typeof(saved_messages) = 'array');
ALTER TABLE campaigns ADD COLUMN flow_step integer NOT NULL DEFAULT 0 CHECK (flow_step >= 0 AND flow_step <= 50);
