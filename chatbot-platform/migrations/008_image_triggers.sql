-- Cuándo se envía cada foto: la IA decide (como hasta ahora), o el sistema la envía en momentos fijos
-- (palabras del cliente, bienvenida, etapa del recorrido, objetivo cumplido, cita agendada).
ALTER TABLE images ADD COLUMN send_when jsonb NOT NULL DEFAULT '{}'::jsonb;
