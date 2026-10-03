-- Avance del recorrido de cada conversación: etapa actual y cuándo se cumplió el objetivo.
ALTER TABLE conversations
  ADD COLUMN flow_step         integer NOT NULL DEFAULT 0,
  ADD COLUMN goal_completed_at timestamptz;

-- Campañas: por defecto solo se envían en horario de atención (lo que no alcance se pasa a la siguiente apertura).
ALTER TABLE campaigns ADD COLUMN business_hours_only boolean NOT NULL DEFAULT true;
