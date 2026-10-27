-- migrate:no-transaction
-- Índices para tablas grandes, construidos sin bloquearlas (CONCURRENTLY, fuera de una transacción).

-- Mensajes por fecha (estadísticas, consumo del mes, retención): BRIN es diminuto y sirve porque la tabla solo crece.
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_created_brin ON messages USING brin (created_at);

-- Trabajos: limpieza de los terminados, recuperación de los colgados y cancelación por lo que los originó.
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_finished_created_idx ON jobs (created_at) WHERE status IN ('done', 'failed', 'cancelled');
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_running_started_idx ON jobs (started_at) WHERE status = 'running';
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_pending_enrollment_idx ON jobs ((payload->>'enrollment_id')) WHERE status = 'pending' AND payload->>'enrollment_id' IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_pending_conversation_idx ON jobs ((payload->>'conversation_id')) WHERE status = 'pending' AND payload->>'conversation_id' IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_pending_appointment_idx ON jobs ((payload->>'appointment_id')) WHERE status = 'pending' AND payload->>'appointment_id' IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_pending_campaign_idx ON jobs ((payload->>'campaign_id')) WHERE status = 'pending' AND payload->>'campaign_id' IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_pending_automation_idx ON jobs ((payload->>'automation_id')) WHERE status = 'pending' AND payload->>'automation_id' IS NOT NULL;

-- Limpieza por antigüedad (el detalle de ai_runs ya tiene el suyo: ai_runs_detail_idx, 025).
CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_created_idx ON notifications (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS alert_receipts_created_idx ON alert_receipts (created_at);

-- Monitoreo: errores recientes de la bitácora.
CREATE INDEX CONCURRENTLY IF NOT EXISTS event_logs_errors_idx ON event_logs (created_at DESC) WHERE level = 'error';

-- Tope diario de campañas: lo enviado por fecha.
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_recipients_sent_idx ON campaign_recipients (sent_at) WHERE status = 'sent';
