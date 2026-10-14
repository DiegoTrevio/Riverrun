CREATE INDEX contacts_account_phone ON contacts(account_id,regexp_replace(phone,'[^0-9]','','g')) WHERE phone<>'';
ALTER TABLE ai_prices ADD COLUMN is_free boolean NOT NULL DEFAULT false;
CREATE TABLE contact_views (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL,
 filters jsonb NOT NULL,
 UNIQUE(account_id,user_id,name)
);
CREATE INDEX contact_views_user ON contact_views(user_id);
CREATE TABLE ai_budget_settings (
 account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0,
 settings jsonb NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_spend (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 chatbot_id uuid REFERENCES chatbots(id) ON DELETE SET NULL,
 kind text NOT NULL,
 models text[] NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','settled','uncertain','unknown','rejected')),
 reserved_usd numeric(28,14),
 charged_usd numeric(28,14),
 cost_source text NOT NULL CHECK(cost_source IN ('reported','estimated','legacy','unknown','confirmed')),
 policy_revision integer NOT NULL DEFAULT 0,
 quote jsonb NOT NULL DEFAULT '{}',
 input_tokens bigint NOT NULL DEFAULT 0,
 output_tokens bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CHECK(reserved_usd IS NULL OR reserved_usd>=0),
 CHECK(charged_usd IS NULL OR charged_usd>=0)
);
CREATE INDEX ai_spend_account_period ON ai_spend(account_id,created_at DESC);
CREATE INDEX ai_spend_bot ON ai_spend(chatbot_id) WHERE chatbot_id IS NOT NULL;
CREATE TABLE ai_budget_notices (
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 day date NOT NULL,
 reason text NOT NULL,
 PRIMARY KEY(account_id,day,reason)
);
-- Legacy zero amounts did not distinguish free calls from unknown tariffs.
INSERT INTO ai_spend(account_id,chatbot_id,kind,models,state,charged_usd,cost_source,input_tokens,output_tokens,created_at,finished_at)
 SELECT account_id,chatbot_id,kind,ARRAY[regexp_replace(model,'^openai/','')],
 CASE WHEN cost_usd>0 THEN 'settled' ELSE 'unknown' END,
 CASE WHEN cost_usd>0 THEN cost_usd ELSE NULL END,
 CASE WHEN cost_usd>0 THEN 'legacy' ELSE 'unknown' END,input_tokens,output_tokens,created_at,created_at
 FROM ai_runs WHERE account_id IS NOT NULL AND NOT(kind='import' AND model='' AND input_tokens=0 AND output_tokens=0);
