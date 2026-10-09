-- Integridad de datos (auditoría de bases de datos).

-- 1) El costo de IA es contabilidad: borrar un asistente o una conversación no debe borrar su historial de costo.
--    La limpieza de privacidad ya borra el detalle (decision/validation) antes de borrar contactos.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_chatbot_id_fkey;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_chatbot_id_fkey FOREIGN KEY (chatbot_id) REFERENCES chatbots(id) ON DELETE SET NULL;
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_conversation_id_fkey;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

-- 2) Huella SHA-256 de cada foto: sirve para comprobar que el archivo guardado es el mismo que se subió.
ALTER TABLE images ADD COLUMN sha256 text NOT NULL DEFAULT '';
ALTER TABLE images ADD CONSTRAINT images_sha256_format CHECK (sha256 = '' OR sha256 ~ '^[0-9a-f]{64}$');

-- 3) Reglas que la aplicación ya exige, también en la base por si se escribe por otro camino.
ALTER TABLE services ADD CONSTRAINT services_duration_min CHECK (duration_minutes >= 5);
ALTER TABLE appointments ADD CONSTRAINT appointments_time_order CHECK (ends_at > starts_at);
ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_nonnegative CHECK (messages >= 0);
