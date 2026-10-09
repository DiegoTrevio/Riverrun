-- Análisis compacto de la conversación junto al resumen (intención, ánimo, interés, acuerdos, pendientes).
ALTER TABLE conversations ADD COLUMN report_analysis jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE conversations ADD CONSTRAINT conversations_report_analysis_object CHECK (jsonb_typeof(report_analysis) = 'object');

-- Compactación: el detalle técnico de cada respuesta de la IA (decisión y validación completas) solo sirve unos días para
-- depurar; después se borra y queda el consumo y el costo (contabilidad). El índice evita recorrer toda la tabla.
CREATE INDEX ai_runs_detail_idx ON ai_runs (created_at) WHERE decision IS NOT NULL OR validation IS NOT NULL;
