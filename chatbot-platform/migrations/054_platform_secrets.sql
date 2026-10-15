-- Llaves de la plataforma que el superadministrador guarda desde el panel (p. ej. la de Zernio), cifradas con la clave
-- del servidor. Una variable de entorno con el mismo propósito tiene prioridad.
CREATE TABLE IF NOT EXISTS platform_secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_secrets_updated_by_idx ON platform_secrets (updated_by);
