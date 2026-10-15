-- Cada negocio conecta Facebook e Instagram con un botón (app de Meta de la plataforma) y tiene su perfil de Zernio
-- desde que se crea la cuenta.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS zernio_profile_id text NOT NULL DEFAULT '';

-- Sesión de «Conectar con Facebook»: estado de un solo uso (30 min) y las páginas que devolvió Meta hasta que el
-- negocio elige cuáles conectar. Se borra al aplicarla.
CREATE TABLE IF NOT EXISTS meta_connect_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chatbot_id uuid REFERENCES chatbots(id) ON DELETE SET NULL,
  state text UNIQUE,
  -- Hash del nonce de la cookie del navegador que inició la conexión: el regreso solo vale en ese navegador.
  nonce_hash text NOT NULL DEFAULT '',
  pages jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS meta_connect_sessions_account_idx ON meta_connect_sessions (account_id);
CREATE INDEX IF NOT EXISTS meta_connect_sessions_chatbot_idx ON meta_connect_sessions (chatbot_id);
CREATE INDEX IF NOT EXISTS meta_connect_sessions_created_by_idx ON meta_connect_sessions (created_by);
