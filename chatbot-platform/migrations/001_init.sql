-- Esquema inicial de la plataforma de chatbots

CREATE TABLE IF NOT EXISTS chatbots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  active             boolean NOT NULL DEFAULT false,
  whatsapp_number    text NOT NULL DEFAULT '',
  evolution_instance text UNIQUE,
  evolution_url      text,          -- opcional: sobreescribe EVOLUTION_URL global
  evolution_api_key  text,          -- opcional: sobreescribe EVOLUTION_API_KEY global
  webhook_token      text NOT NULL UNIQUE,
  personality        jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules              jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_fields        jsonb NOT NULL DEFAULT '[]'::jsonb,
  flow               jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id     uuid NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
  category       text NOT NULL DEFAULT 'general',
  title          text NOT NULL,
  content        text NOT NULL,
  always_include boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_items_chatbot_idx ON knowledge_items(chatbot_id);

CREATE TABLE IF NOT EXISTS images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id  uuid NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
  code        text NOT NULL,              -- ID legible que usa la IA, p.ej. "menu_general"
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',   -- qué muestra la imagen
  usage_rule  text NOT NULL DEFAULT '',   -- cuándo debe enviarse
  caption     text NOT NULL DEFAULT '',   -- pie de foto opcional al enviarla
  file_path   text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chatbot_id, code)
);

CREATE TABLE IF NOT EXISTS contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id  uuid NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
  jid         text NOT NULL,             -- identificador de WhatsApp (remoteJid)
  phone       text NOT NULL DEFAULT '',
  push_name   text NOT NULL DEFAULT '',  -- nombre de perfil de WhatsApp
  name        text NOT NULL DEFAULT '',  -- nombre confirmado por el cliente
  data        jsonb NOT NULL DEFAULT '{}'::jsonb, -- datos recopilados
  notes       jsonb NOT NULL DEFAULT '[]'::jsonb, -- hechos/intereses recordados
  channel     text NOT NULL DEFAULT 'whatsapp',   -- whatsapp | playground
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chatbot_id, jid)
);

CREATE TABLE IF NOT EXISTS conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id          uuid NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','human','closed')),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  handoff_reason      text NOT NULL DEFAULT '',
  summary             text NOT NULL DEFAULT '',
  summary_until_id    bigint NOT NULL DEFAULT 0,
  last_message_at     timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id)
);
CREATE INDEX IF NOT EXISTS conversations_chatbot_idx ON conversations(chatbot_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                   bigserial PRIMARY KEY,
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('in','out')),
  sender               text NOT NULL CHECK (sender IN ('customer','bot','human','system')),
  type                 text NOT NULL DEFAULT 'text',
  content              text NOT NULL DEFAULT '',
  image_id             uuid REFERENCES images(id) ON DELETE SET NULL,
  evolution_message_id text,
  processed            boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'ok',   -- ok | pending | failed
  meta                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_unprocessed_idx ON messages(conversation_id) WHERE processed = false;
CREATE UNIQUE INDEX IF NOT EXISTS messages_evolution_id_idx ON messages(conversation_id, evolution_message_id) WHERE evolution_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_runs (
  id               bigserial PRIMARY KEY,
  chatbot_id       uuid REFERENCES chatbots(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'decision', -- decision | summary | transcription
  model            text NOT NULL,
  input_tokens     integer NOT NULL DEFAULT 0,
  cached_tokens    integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  latency_ms       integer NOT NULL DEFAULT 0,
  attempt          integer NOT NULL DEFAULT 1,
  decision         jsonb,
  validation       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_runs_chatbot_idx ON ai_runs(chatbot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_logs (
  id          bigserial PRIMARY KEY,
  chatbot_id  uuid REFERENCES chatbots(id) ON DELETE CASCADE,
  conversation_id uuid,
  level       text NOT NULL CHECK (level IN ('debug','info','warn','error')),
  source      text NOT NULL,   -- webhook | evolution | ai | validator | engine | admin | system
  message     text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_logs_created_idx ON event_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS event_logs_chatbot_idx ON event_logs(chatbot_id, created_at DESC);
