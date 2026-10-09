-- Estadísticas por persona: cada vez que una conversación pasa a una persona queda registrada (quién, cuándo y cómo).
-- Así el conteo por persona incluye también las conversaciones que se reasignaron, no solo la última persona.
CREATE TABLE IF NOT EXISTS conversation_assignments (
  id               bigserial PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  source           text NOT NULL CHECK (source IN ('round_robin', 'manual', 'takeover', 'api', 'anterior')),
  reason           text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_assignments_account_idx      ON conversation_assignments (account_id, created_at);
CREATE INDEX IF NOT EXISTS conversation_assignments_user_idx         ON conversation_assignments (user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_assignments_conversation_idx ON conversation_assignments (conversation_id);

-- Las asignaciones que ya existían se conservan como origen "anterior" (solo se guardó la última persona).
INSERT INTO conversation_assignments (account_id, conversation_id, user_id, source, reason, created_at)
SELECT account_id, id, assigned_user_id, 'anterior', 'asignada antes del historial', assigned_at
  FROM conversations
 WHERE assigned_user_id IS NOT NULL AND assigned_at IS NOT NULL;

-- Mensajes enviados desde el panel: quién los envió (meta.user_id), para contarlos por persona.
CREATE INDEX IF NOT EXISTS messages_human_user_idx ON messages ((meta->>'user_id')) WHERE sender = 'human';

-- Consultas de estadísticas por cuenta y fecha.
CREATE INDEX IF NOT EXISTS conversations_account_created_idx ON conversations (account_id, created_at);
CREATE INDEX IF NOT EXISTS conversations_account_open_idx    ON conversations (account_id, status) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS ai_runs_account_created_idx       ON ai_runs (account_id, created_at);
