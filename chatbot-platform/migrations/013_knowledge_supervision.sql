CREATE TABLE knowledge_monitor_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL,
  pending_since timestamptz,
  pending_signature text NOT NULL DEFAULT '',
  metrics jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE knowledge_monitor_samples (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  metrics jsonb NOT NULL
);
CREATE INDEX knowledge_monitor_samples_account_time_idx ON knowledge_monitor_samples(account_id,observed_at DESC);
CREATE TABLE knowledge_alerts (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pending','embedding','fallback','latency','cost','delivery','configuration')),
  active boolean NOT NULL DEFAULT false,
  opened_at timestamptz,
  resolved_at timestamptz,
  last_notified_at timestamptz,
  PRIMARY KEY(account_id,kind)
);
CREATE INDEX knowledge_events_monitor_idx ON event_logs(account_id,created_at DESC) WHERE message IN ('knowledge_search','knowledge_embedding');
