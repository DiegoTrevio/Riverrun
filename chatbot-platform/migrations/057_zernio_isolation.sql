-- Una cuenta de Zernio pertenece a un solo negocio y a un solo canal.
-- Duplicados que ya existan: se conserva el canal cuyo perfil es el del negocio (si no, el más antiguo); los demás
-- quedan sin cuenta y desconectados, para que nadie reciba ni envíe por una cuenta que no es suya.
WITH ranked AS (
  SELECT c.id, row_number() OVER (
           PARTITION BY c.config->>'account_id'
           ORDER BY (a.zernio_profile_id <> '' AND c.config->>'profile_id' = a.zernio_profile_id) DESC, c.created_at, c.id
         ) AS rn
    FROM channels c JOIN accounts a ON a.id = c.account_id
   WHERE c.type = 'zernio' AND coalesce(c.config->>'account_id', '') <> ''
)
UPDATE channels c
   SET config = c.config || '{"account_id": "", "username": "", "display_name": "", "picture": ""}'::jsonb,
       connection_state = 'close', connection_state_at = now(), disconnect_reason = 'zernio_duplicate'
  FROM ranked r
 WHERE r.id = c.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS channels_zernio_account_idx ON channels ((config->>'account_id'))
  WHERE type = 'zernio' AND config->>'account_id' <> '';
