-- Cuentas (clientes con login propio), usuarios y canales multiplataforma.
-- Convierte los datos existentes: todo pasa a una "Cuenta principal" y cada
-- WhatsApp configurado en un chatbot se vuelve un canal (conserva la URL del webhook).

CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('superadmin', 'admin', 'agent')),
  name          text NOT NULL DEFAULT '',
  email         text NOT NULL,           -- identificador de acceso (correo o usuario)
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- El superadministrador no pertenece a ninguna cuenta; los demás sí.
  CHECK ((role = 'superadmin') = (account_id IS NULL))
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));
CREATE INDEX users_account_idx ON users (account_id);

-- Cuenta para lo que ya existía
INSERT INTO accounts (name) SELECT 'Cuenta principal' WHERE EXISTS (SELECT 1 FROM chatbots);

ALTER TABLE chatbots ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
UPDATE chatbots SET account_id = (SELECT id FROM accounts ORDER BY created_at LIMIT 1);
ALTER TABLE chatbots ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX chatbots_account_idx ON chatbots (account_id);

CREATE TABLE channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chatbot_id    uuid REFERENCES chatbots(id) ON DELETE SET NULL,  -- sin chatbot: guarda mensajes pero no responde
  type          text NOT NULL CHECK (type IN ('whatsapp', 'telegram', 'messenger', 'instagram', 'webchat', 'playground')),
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- credenciales y ajustes propios de la plataforma
  webhook_token text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_account_idx ON channels (account_id);
CREATE INDEX channels_chatbot_idx ON channels (chatbot_id);
CREATE UNIQUE INDEX channels_whatsapp_instance_idx ON channels ((config->>'instance'))
  WHERE type = 'whatsapp' AND coalesce(config->>'instance', '') <> '';
CREATE UNIQUE INDEX channels_playground_idx ON channels (chatbot_id) WHERE type = 'playground';

-- WhatsApp existente → canal (mismo token = misma URL de webhook en Evolution)
INSERT INTO channels (account_id, chatbot_id, type, name, active, config, webhook_token)
SELECT b.account_id, b.id, 'whatsapp', 'WhatsApp ' || b.name, true,
       jsonb_strip_nulls(jsonb_build_object(
         'instance', b.evolution_instance,
         'url', b.evolution_url,
         'api_key', b.evolution_api_key,
         'number', nullif(b.whatsapp_number, ''))),
       b.webhook_token
FROM chatbots b
WHERE b.evolution_instance IS NOT NULL
   OR EXISTS (SELECT 1 FROM contacts c WHERE c.chatbot_id = b.id AND c.channel = 'whatsapp');

-- Conversaciones del simulador → canal interno del chatbot
INSERT INTO channels (account_id, chatbot_id, type, name, webhook_token)
SELECT b.account_id, b.id, 'playground', 'Simulador', encode(gen_random_bytes(18), 'hex')
FROM chatbots b
WHERE EXISTS (SELECT 1 FROM contacts c WHERE c.chatbot_id = b.id AND c.channel = 'playground');

-- Contactos: pertenecen a un canal
ALTER TABLE contacts RENAME COLUMN jid TO external_id;
ALTER TABLE contacts ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE contacts ADD COLUMN channel_id uuid REFERENCES channels(id) ON DELETE CASCADE;
UPDATE contacts c SET channel_id = ch.id, account_id = ch.account_id
FROM channels ch
WHERE ch.chatbot_id = c.chatbot_id
  AND ch.type = CASE WHEN c.channel = 'playground' THEN 'playground' ELSE 'whatsapp' END;
DELETE FROM contacts WHERE channel_id IS NULL;
ALTER TABLE contacts ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE contacts ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE contacts DROP CONSTRAINT contacts_chatbot_id_jid_key;
ALTER TABLE contacts DROP COLUMN chatbot_id;
ALTER TABLE contacts DROP COLUMN channel;
ALTER TABLE contacts ADD CONSTRAINT contacts_channel_external_key UNIQUE (channel_id, external_id);
CREATE INDEX contacts_account_idx ON contacts (account_id);

-- Conversaciones: cuenta y canal; el chatbot es el que la atiende (puede cambiar)
ALTER TABLE conversations ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN channel_id uuid REFERENCES channels(id) ON DELETE CASCADE;
UPDATE conversations cv SET channel_id = c.channel_id, account_id = c.account_id
FROM contacts c WHERE c.id = cv.contact_id;
ALTER TABLE conversations ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN chatbot_id DROP NOT NULL;
ALTER TABLE conversations DROP CONSTRAINT conversations_chatbot_id_fkey;
ALTER TABLE conversations ADD CONSTRAINT conversations_chatbot_id_fkey
  FOREIGN KEY (chatbot_id) REFERENCES chatbots(id) ON DELETE SET NULL;
CREATE INDEX conversations_account_idx ON conversations (account_id, last_message_at DESC);
CREATE INDEX conversations_channel_idx ON conversations (channel_id);

-- Mensajes: el ID externo ya no es solo de Evolution
ALTER TABLE messages RENAME COLUMN evolution_message_id TO external_message_id;

-- Uso de IA y registros por cuenta
ALTER TABLE ai_runs ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
UPDATE ai_runs r SET account_id = b.account_id FROM chatbots b WHERE b.id = r.chatbot_id;
CREATE INDEX ai_runs_account_idx ON ai_runs (account_id, created_at DESC);

ALTER TABLE event_logs ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE event_logs ADD COLUMN channel_id uuid REFERENCES channels(id) ON DELETE SET NULL;
UPDATE event_logs l SET account_id = b.account_id FROM chatbots b WHERE b.id = l.chatbot_id;
CREATE INDEX event_logs_account_idx ON event_logs (account_id, created_at DESC);

-- La conexión con WhatsApp ahora vive en el canal
ALTER TABLE chatbots DROP COLUMN whatsapp_number;
ALTER TABLE chatbots DROP COLUMN evolution_instance;
ALTER TABLE chatbots DROP COLUMN evolution_url;
ALTER TABLE chatbots DROP COLUMN evolution_api_key;
ALTER TABLE chatbots DROP COLUMN webhook_token;
