-- Cuándo salió el último aviso de cada incidencia. Así un reinicio no repite el aviso de un fallo que sigue, y la
-- recuperación se anuncia aunque el proceso se haya reiniciado mientras la incidencia estaba abierta.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
