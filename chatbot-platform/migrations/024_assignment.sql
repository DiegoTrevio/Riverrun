-- Asignación de conversaciones al equipo (round robin) y disponibilidad de cada persona.
ALTER TABLE conversations ADD COLUMN assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN assigned_at timestamptz;
CREATE INDEX conversations_assigned_idx ON conversations (assigned_user_id) WHERE assigned_user_id IS NOT NULL;

-- "Disponible": quien está fuera de turno (vacaciones, descanso) se salta en el reparto sin desactivar su usuario.
ALTER TABLE users ADD COLUMN available boolean NOT NULL DEFAULT true;

-- Puntero del turno: a quién le tocó la última vez, por cuenta y por reparto (transferencias, cada regla…).
CREATE TABLE round_robin (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope        text NOT NULL,
  last_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, scope)
);
CREATE INDEX round_robin_user_idx ON round_robin (last_user_id) WHERE last_user_id IS NOT NULL;
