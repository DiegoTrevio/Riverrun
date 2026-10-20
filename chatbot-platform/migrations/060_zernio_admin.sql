-- Presupuesto de llamadas a Zernio: el límite por minuto es de toda la plataforma (una sola llave para todos los
-- negocios), así que se reparte entre procesos con una cubeta de fichas en la base.
CREATE TABLE IF NOT EXISTS rate_buckets (
  key        text PRIMARY KEY,
  tokens     double precision NOT NULL,
  capacity   double precision NOT NULL,
  per_sec    double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Conexiones de redes por negocio (sin conexión de mensajes): desde "Redes sociales" (panel) o con un enlace que el
-- administrador le manda al cliente (link). El estado se guarda solo como huella y sirve una vez.
CREATE TABLE IF NOT EXISTS zernio_connect_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash  text NOT NULL UNIQUE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  chatbot_id  uuid REFERENCES chatbots(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('panel', 'link')),
  -- Reconectar una cuenta que ya existe en Zernio (conserva su historial allá).
  reconnect_account_id text NOT NULL DEFAULT '',
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zernio_connect_sessions_account_idx ON zernio_connect_sessions (account_id);
CREATE INDEX IF NOT EXISTS zernio_connect_sessions_chatbot_idx ON zernio_connect_sessions (chatbot_id);
CREATE INDEX IF NOT EXISTS zernio_connect_sessions_user_idx ON zernio_connect_sessions (created_by);
