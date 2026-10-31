-- Etapa 3c (ID-12): la API v1 solo acepta llaves cuyo creador sigue siendo administrador activo de la cuenta (o el
-- superadministrador). Las que no cumplen (creador borrado directo en la base, desactivado o movido sin pasar por las
-- rutas) se revocan aquí de forma explícita, con una nota en la bitácora de su cuenta, en vez de dejar de entrar en
-- silencio. Volver a correrla no cambia nada.

WITH orphan AS (
  SELECT k.id FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
   WHERE k.revoked_at IS NULL
     AND (u.id IS NULL OR NOT u.active
          OR (u.role <> 'superadmin' AND (u.role <> 'admin' OR u.account_id IS DISTINCT FROM k.account_id)))
), revoked AS (
  UPDATE api_keys k SET revoked_at = now() FROM orphan o WHERE k.id = o.id RETURNING k.id, k.account_id, k.name
)
INSERT INTO event_logs (account_id, level, source, message, details)
SELECT account_id, 'warn', 'admin', 'Llave de API revocada: quien la creó ya no es administrador de la cuenta. Crea otra en Integraciones si la usabas.',
       jsonb_build_object('api_key_id', id, 'name', name)
  FROM revoked;
