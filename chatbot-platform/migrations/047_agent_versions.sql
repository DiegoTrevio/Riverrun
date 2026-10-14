-- Operational on/off remains immediate; configuration releases are immutable snapshots.
CREATE FUNCTION agent_configuration(b chatbots) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('name',b.name,'personality',b.personality,'rules',b.rules,'data_fields',b.data_fields,'flow',b.flow,'ai',b.ai,'saved_messages',b.saved_messages)
$$;
CREATE TABLE agent_releases (
 id bigserial PRIMARY KEY,
 chatbot_id uuid NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
 configuration jsonb NOT NULL,
 image_rules jsonb NOT NULL DEFAULT '[]',
 author_id uuid REFERENCES users(id) ON DELETE SET NULL,
 author_name text NOT NULL DEFAULT 'Sistema / API',
 reason text NOT NULL DEFAULT 'Configuración actualizada',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_releases_bot ON agent_releases(chatbot_id,id DESC);
CREATE INDEX agent_releases_author ON agent_releases(author_id) WHERE author_id IS NOT NULL;
INSERT INTO agent_releases(chatbot_id,configuration,image_rules,reason) SELECT id,agent_configuration(chatbots),coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'send_when',i.send_when)) FROM images i WHERE i.chatbot_id=chatbots.id),'[]'),'Versión inicial' FROM chatbots;
CREATE FUNCTION capture_agent_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR agent_configuration(NEW) IS DISTINCT FROM agent_configuration(OLD) THEN
  INSERT INTO agent_releases(chatbot_id,configuration,image_rules,author_id,author_name,reason)
  VALUES(NEW.id,agent_configuration(NEW),coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'send_when',i.send_when)) FROM images i WHERE i.chatbot_id=NEW.id),'[]'),nullif(current_setting('riverrun.author_id',true),'')::uuid,
    coalesce(nullif(current_setting('riverrun.author_name',true),''),'Sistema / API'),
    coalesce(nullif(current_setting('riverrun.release_reason',true),''),'Configuración actualizada'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_release AFTER INSERT OR UPDATE ON chatbots FOR EACH ROW EXECUTE FUNCTION capture_agent_release();
CREATE TABLE agent_drafts (
 chatbot_id uuid PRIMARY KEY REFERENCES chatbots(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0,
 configuration jsonb NOT NULL,
 base_configuration jsonb NOT NULL,
 step_map jsonb,
 image_rules jsonb,
 author_id uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_test_suites (
 chatbot_id uuid PRIMARY KEY REFERENCES chatbots(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0,
 cases jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX agent_drafts_author ON agent_drafts(author_id) WHERE author_id IS NOT NULL;
CREATE TABLE agent_test_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 chatbot_id uuid NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
 draft_revision integer NOT NULL,
 signature text NOT NULL,
 author_id uuid REFERENCES users(id) ON DELETE SET NULL,
 status text NOT NULL CHECK(status IN ('running','passed','failed','error')),
 results jsonb NOT NULL DEFAULT '[]',
 models jsonb NOT NULL DEFAULT '[]',
 calls integer NOT NULL DEFAULT 0,
 input_tokens bigint NOT NULL DEFAULT 0,
 output_tokens bigint NOT NULL DEFAULT 0,
 cost_usd numeric,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX agent_test_runs_bot ON agent_test_runs(chatbot_id,created_at DESC);
CREATE INDEX agent_test_runs_author ON agent_test_runs(author_id) WHERE author_id IS NOT NULL;
CREATE UNIQUE INDEX agent_test_run_active ON agent_test_runs(chatbot_id) WHERE status='running';
