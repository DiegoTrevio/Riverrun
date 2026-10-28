-- Lienzo de flujos: el dibujo (mensajes, esperas, botones, notas y fotos) se guarda tal cual y, al publicarse, se
-- convierte en una regla y en los flujos (secuencias) que ya ejecuta el sistema. `published_map` recuerda qué regla y qué
-- secuencias creó cada lienzo, para actualizarlas al volver a publicar en lugar de duplicarlas.
CREATE TABLE IF NOT EXISTS flow_boards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  board              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(board) = 'object'),
  revision           integer NOT NULL DEFAULT 0,
  published_revision integer,
  published_at       timestamptz,
  published_map      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(published_map) = 'object'),
  -- Huella de lo que se publicó (mensajes, botones, esperas, inicio): mover tarjetas no cuenta como cambio por publicar.
  published_hash     text,
  paused             boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_boards_account_idx ON flow_boards (account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS flow_boards_created_by_idx ON flow_boards (created_by) WHERE created_by IS NOT NULL;

-- La regla y los flujos que salieron de un lienzo lo dicen (el panel avisa que se editan desde ahí).
ALTER TABLE automations ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES flow_boards(id) ON DELETE SET NULL;
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES flow_boards(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS automations_board_idx ON automations (board_id) WHERE board_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sequences_board_idx ON sequences (board_id) WHERE board_id IS NOT NULL;

-- Un flujo que empezó el cliente (escribió una palabra, es nuevo o tocó un botón) le contesta lo que pidió: mientras haya
-- escrito en las últimas 24 h sus mensajes no piden el consentimiento de promociones (el pie de baja sí va).
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS started_by_customer boolean NOT NULL DEFAULT false;
