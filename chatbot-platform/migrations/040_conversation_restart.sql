-- Reiniciar una conversación (desde el panel, o todas las de un asistente al actualizarlo): los mensajes hasta este id
-- son de antes del reinicio. El historial se conserva para el equipo, pero el asistente ya no los ve ni cuentan para la
-- bienvenida: la siguiente respuesta es la primera del recorrido nuevo.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS restarted_after_id bigint NOT NULL DEFAULT 0;
