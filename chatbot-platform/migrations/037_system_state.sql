-- Estado interno de la plataforma (no de los clientes): versión de Evolution detectada y cuándo cambió,
-- y el resultado de la última comprobación de servicios. Sobrevive a los reinicios; nunca guarda secretos.
CREATE TABLE IF NOT EXISTS system_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
