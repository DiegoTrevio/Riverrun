-- Cada recorrido (de la primera respuesta hasta que se cierra o se borra la memoria) lleva su propia marca de inicio:
-- las fotos "una sola vez" se cuentan desde ahí, así que al reabrir una conversación vuelven a salir las de etapa y objetivo.
ALTER TABLE conversations ADD COLUMN flow_started_at timestamptz;
