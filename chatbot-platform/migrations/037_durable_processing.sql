CREATE TABLE conversation_work (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','dead')),
  run_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1,
  claimed_revision bigint,
  token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  restarts integer NOT NULL DEFAULT 0,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_work_due ON conversation_work(run_at) WHERE state IN ('pending','running');
CREATE TABLE inbound_receipts (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  message_id text NOT NULL,
  from_me boolean NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','dead')),
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id,external_id,message_id,from_me)
);
CREATE INDEX inbound_receipts_due ON inbound_receipts(run_at) WHERE state IN ('pending','running');
CREATE TABLE worker_limits (id boolean PRIMARY KEY DEFAULT true CHECK(id), concurrency integer NOT NULL CHECK(concurrency BETWEEN 1 AND 6));
CREATE TABLE delivery_attempts (
  operation_key text NOT NULL,
  part integer NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
  state text NOT NULL CHECK(state IN ('prepared','sending','sent','rejected','uncertain','cancelled')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(operation_key,part)
);
CREATE INDEX delivery_attempts_conversation ON delivery_attempts(conversation_id,updated_at DESC);
ALTER TABLE conversations ADD COLUMN control_version bigint NOT NULL DEFAULT 0;
CREATE FUNCTION bump_conversation_control() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.agent_off_until IS DISTINCT FROM OLD.agent_off_until OR NEW.agent_off_reason IS DISTINCT FROM OLD.agent_off_reason THEN
    NEW.control_version := OLD.control_version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_control BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION bump_conversation_control();
CREATE TABLE semantic_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean,
  preparing boolean NOT NULL DEFAULT false,
  daily_token_budget integer NOT NULL DEFAULT 100000 CHECK(daily_token_budget BETWEEN 100 AND 10000000),
  verified_model text,
  tested_signature text,
  tested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE embedding_usage (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  reserved_tokens integer NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,day)
);
CREATE TABLE knowledge_preparation_state (
  item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  model text NOT NULL,
  content_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(item_id,model)
);
CREATE TABLE query_embedding_cache (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  model text NOT NULL,
  query_hash text NOT NULL,
  vectors jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,model,query_hash)
);
