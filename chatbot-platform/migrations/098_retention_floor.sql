-- Etapa 3c (ID-13): el borrado automático pide al menos 30 días (0 = conservar siempre). Lo que estaba entre 1 y 29 sube
-- a 30, y queda en la bitácora de la cuenta para que el dueño lo vea. Volver a correrla no cambia nada.

INSERT INTO event_logs (account_id, level, source, message, details)
SELECT id, 'warn', 'admin', 'Retención de datos subida al mínimo de 30 días',
       jsonb_build_object('messages_days', settings->'retention'->'messages_days', 'inactive_contacts_days', settings->'retention'->'inactive_contacts_days')
  FROM accounts
 WHERE coalesce((settings->'retention'->>'messages_days')::int, 0) BETWEEN 1 AND 29
    OR coalesce((settings->'retention'->>'inactive_contacts_days')::int, 0) BETWEEN 1 AND 29;

UPDATE accounts
   SET settings = jsonb_set(settings, '{retention}', (settings->'retention') || jsonb_build_object(
         'messages_days', CASE WHEN coalesce((settings->'retention'->>'messages_days')::int, 0) BETWEEN 1 AND 29 THEN 30 ELSE coalesce((settings->'retention'->>'messages_days')::int, 0) END,
         'inactive_contacts_days', CASE WHEN coalesce((settings->'retention'->>'inactive_contacts_days')::int, 0) BETWEEN 1 AND 29 THEN 30 ELSE coalesce((settings->'retention'->>'inactive_contacts_days')::int, 0) END))
 WHERE coalesce((settings->'retention'->>'messages_days')::int, 0) BETWEEN 1 AND 29
    OR coalesce((settings->'retention'->>'inactive_contacts_days')::int, 0) BETWEEN 1 AND 29;
