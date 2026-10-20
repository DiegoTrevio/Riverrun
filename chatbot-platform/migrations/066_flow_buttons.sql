-- Flujos con botones. Los botones de cada paso viven en sequences.steps (jsonb); aquí: el juego de botones vigente de
-- cada conversación, la elección del cliente en su inscripción, flujos enviados a un grupo (campañas de flujo) y el
-- ritmo de envío por canal para los pasos siguientes de esas campañas.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_buttons jsonb;

ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS choice_step integer,
  ADD COLUMN IF NOT EXISTS choice text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pace_ms integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS sequence_enrollments_campaign_idx ON sequence_enrollments (campaign_id);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'sequence')),
  ADD COLUMN IF NOT EXISTS sequence_id uuid REFERENCES sequences(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS campaigns_sequence_idx ON campaigns (sequence_id);

CREATE TABLE IF NOT EXISTS send_pacing (
  channel_id   uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  next_free_at timestamptz NOT NULL DEFAULT now()
);
