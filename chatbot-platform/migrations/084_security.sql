-- Seguridad (auditoría de octubre 2026).

-- 1) Messenger e Instagram conectados con el botón «Conectar con Facebook»: el webhook de la plataforma entrega cada
-- evento al canal de la página. Antes el panel podía escribir `connected_via` y la página de otro negocio; desde ahora
-- solo el servidor pone la marca `meta_connected_at`, y una página conectada pertenece a un solo canal.

-- Un canal que ya decía «conectado con Facebook» pudo haberse escrito a mano antes de este cambio. Solo se confía de
-- inmediato en los que tienen evidencia de haberse conectado con el botón (su registro «Facebook: … conectado»); los
-- demás quedan pendientes de verificar con Meta (meta-connect.ts, verifyPendingMetaChannels): si su token es de esa
-- página reciben la marca; si no, se desconectan. Mientras tanto no reciben eventos.
CREATE TEMP TABLE meta_candidates ON COMMIT DROP AS
SELECT c.id, c.account_id, c.type, c.created_at,
       CASE WHEN c.type = 'messenger' THEN c.config->>'page_id' ELSE c.config->>'account_id' END AS page_key,
       EXISTS (SELECT 1 FROM event_logs l WHERE l.channel_id = c.id AND l.message LIKE 'Facebook: % conectado') AS proven
  FROM channels c
 WHERE c.type IN ('messenger', 'instagram') AND c.config->>'connected_via' = 'facebook' AND coalesce(c.config->>'page_access_token', '') <> '';

-- Una página en varios canales: se conserva el que tiene evidencia (y entre esos, el más antiguo); los demás quedan
-- como manuales y sin token de página, con aviso en el registro de su cuenta. Un canal sin página no entra aquí.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY type, page_key ORDER BY proven DESC, created_at, id) AS n
    FROM meta_candidates WHERE coalesce(page_key, '') <> ''
), dropped AS (
  UPDATE channels c SET config = c.config || '{"connected_via": "manual", "page_access_token": ""}'::jsonb, updated_at = now()
    FROM ranked r WHERE r.id = c.id AND r.n > 1
  RETURNING c.id, c.account_id
)
INSERT INTO event_logs (account_id, channel_id, level, source, message)
SELECT account_id, id, 'warn', 'channel', 'Este canal tenía una página de Facebook que ya está conectada en otro canal: se desconectó. Si es tuya, vuelve a conectarla con «Conectar con Facebook».'
  FROM dropped;

UPDATE channels c SET config = c.config || jsonb_build_object('meta_connected_at', to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  FROM meta_candidates m
 WHERE m.id = c.id AND m.proven AND c.config->>'connected_via' = 'facebook' AND coalesce(c.config->>'meta_connected_at', '') = '';
UPDATE channels c SET config = c.config || '{"meta_verify": "pending"}'::jsonb
  FROM meta_candidates m
 WHERE m.id = c.id AND NOT m.proven AND c.config->>'connected_via' = 'facebook' AND coalesce(c.config->>'meta_connected_at', '') = '';

CREATE UNIQUE INDEX IF NOT EXISTS channels_meta_page_idx ON channels ((config->>'page_id'))
  WHERE type = 'messenger' AND config->>'connected_via' = 'facebook' AND coalesce(config->>'page_access_token', '') <> '';
CREATE UNIQUE INDEX IF NOT EXISTS channels_meta_instagram_idx ON channels ((config->>'account_id'))
  WHERE type = 'instagram' AND config->>'connected_via' = 'facebook' AND coalesce(config->>'page_access_token', '') <> '';

-- 2) Sesiones del panel: cada inicio de sesión queda registrado, así cerrar sesión la invalida en el servidor y cada
-- persona ve y cierra las suyas desde Mi perfil.
CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 300),
  ip text NOT NULL DEFAULT '' CHECK (length(ip) <= 64),
  via text NOT NULL DEFAULT 'password' CHECK (via IN ('password', 'google', 'invite', 'signup', 'password_change'))
);
-- Sin filtro parcial: también lo usa el borrado en cascada de un usuario.
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at);
