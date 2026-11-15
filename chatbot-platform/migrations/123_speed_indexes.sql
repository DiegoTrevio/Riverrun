-- migrate:no-transaction
-- Índices para lo que más se consulta al operar, construidos sin bloquear las tablas (CONCURRENTLY).

-- Avisos de «entregado», «leído» o «falló» de Zernio: buscan el mensaje por su id externo sin saber la conversación. El
-- índice (conversation_id, external_message_id) no sirve sin la conversación por delante.
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_external_out_idx
  ON messages (external_message_id)
  WHERE external_message_id IS NOT NULL AND direction = 'out';

-- Registros y corridas de IA del panel: se listan por cuenta del más nuevo al más viejo (ORDER BY id DESC LIMIT n).
CREATE INDEX CONCURRENTLY IF NOT EXISTS event_logs_account_id_idx ON event_logs (account_id, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_runs_account_id_idx ON ai_runs (account_id, id DESC);
