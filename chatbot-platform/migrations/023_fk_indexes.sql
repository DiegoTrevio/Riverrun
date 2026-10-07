-- Índices en llaves foráneas que no los tenían: borrar una cuenta, un usuario o una conversación (y el derecho de supresión)
-- obligaba a recorrer completas estas tablas. Son parciales (solo filas con valor) para que pesen poco.
CREATE INDEX IF NOT EXISTS accounts_brand_idx             ON accounts (brand_id)            WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS accounts_owner_idx             ON accounts (owner_user_id)       WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_runs_conversation_idx       ON ai_runs (conversation_id)      WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_keys_created_by_idx        ON api_keys (created_by)          WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointments_assigned_idx      ON appointments (assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointments_conversation_idx  ON appointments (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automations_chatbot_idx        ON automations (chatbot_id)       WHERE chatbot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_events_account_idx     ON billing_events (account_id)    WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_recipients_conv_idx   ON campaign_recipients (conversation_id);
CREATE INDEX IF NOT EXISTS campaigns_channel_idx          ON campaigns (channel_id)         WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaigns_image_idx            ON campaigns (image_id)           WHERE image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_logs_channel_idx         ON event_logs (channel_id)        WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_account_idx               ON jobs (account_id)              WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_image_idx             ON messages (image_id)            WHERE image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_account_idx      ON notifications (account_id)     WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sequence_enrollments_account_idx ON sequence_enrollments (account_id);
CREATE INDEX IF NOT EXISTS sequences_account_idx          ON sequences (account_id);
CREATE INDEX IF NOT EXISTS wa_pool_hits_channel_idx       ON wa_pool_hits (channel_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_account_idx ON webhook_deliveries (account_id);
