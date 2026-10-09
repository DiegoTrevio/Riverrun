-- Momento en que se terminaron las preguntas de la lista en el recorrido actual (se reinicia con el recorrido).
-- Se registra aunque ese turno no envíe mensajes (transferencia o sin respuesta), para no volver a dispararlo.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS questions_done_at timestamptz;
