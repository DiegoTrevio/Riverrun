-- Cola durable y segura con varios procesos: cada conversación se procesa "con arrendamiento" (lease) en PostgreSQL.
--  lease_until/lease_owner: quién la está atendiendo ahora (vence solo si el proceso se cae)
--  last_attempt_at:         cuándo se intentó responder por última vez (para no reintentar en bucle los errores)
ALTER TABLE conversations
  ADD COLUMN lease_owner      text,
  ADD COLUMN lease_until      timestamptz,
  ADD COLUMN last_attempt_at  timestamptz;
CREATE INDEX conversations_lease_idx ON conversations (lease_until) WHERE lease_until IS NOT NULL;
