-- Zernio con una sola llave para todos los negocios: de quién es cada perfil y cada cuenta conectada.

-- Perfiles de Zernio de cada negocio (externalId = id del negocio). Puede haber más de uno por negocio (Zernio admite
-- un solo WhatsApp por perfil). El principal sigue en accounts.zernio_profile_id.
CREATE TABLE IF NOT EXISTS zernio_profiles (
  profile_id  text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id text NOT NULL UNIQUE,
  is_primary  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zernio_profiles_account_idx ON zernio_profiles (account_id);
INSERT INTO zernio_profiles (profile_id, account_id, external_id)
  SELECT zernio_profile_id, id, id::text FROM accounts WHERE zernio_profile_id <> ''
  ON CONFLICT DO NOTHING;

-- Cuentas de redes conectadas por Zernio: la única fuente de qué negocio es dueño de cada cuenta. Una conexión de
-- mensajes (channels) apunta a una fila; comentarios, publicaciones y estadísticas usan la misma.
CREATE TABLE IF NOT EXISTS social_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  zernio_account_id text NOT NULL UNIQUE,
  profile_id        text NOT NULL DEFAULT '',
  platform          text NOT NULL DEFAULT '',
  username          text NOT NULL DEFAULT '',
  display_name      text NOT NULL DEFAULT '',
  picture           text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect', 'disconnected', 'stale')),
  health            jsonb NOT NULL DEFAULT '{}',
  token_expires_at  timestamptz,
  channel_id        uuid UNIQUE REFERENCES channels(id) ON DELETE SET NULL,
  chatbot_id        uuid REFERENCES chatbots(id) ON DELETE SET NULL,
  comment_settings  jsonb NOT NULL DEFAULT '{}',
  connected_at      timestamptz NOT NULL DEFAULT now(),
  last_checked_at   timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_accounts_account_idx ON social_accounts (account_id);
CREATE INDEX IF NOT EXISTS social_accounts_chatbot_idx ON social_accounts (chatbot_id);

-- Las conexiones de mensajes que ya existen.
INSERT INTO social_accounts (account_id, zernio_account_id, profile_id, platform, username, display_name, picture, status, channel_id, chatbot_id)
  SELECT c.account_id, c.config->>'account_id', coalesce(c.config->>'profile_id', ''), coalesce(c.config->>'platform', ''),
         coalesce(c.config->>'username', ''), coalesce(c.config->>'display_name', ''), coalesce(c.config->>'picture', ''),
         CASE WHEN c.connection_state = 'close' THEN 'needs_reconnect' ELSE 'active' END, c.id, c.chatbot_id
    FROM channels c
   WHERE c.type = 'zernio' AND coalesce(c.config->>'account_id', '') <> ''
  ON CONFLICT DO NOTHING;
