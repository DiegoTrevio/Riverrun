-- Tope de IA de la plataforma (PAY-20): cuánto puede gastar en IA al mes cada plan (y una excepción por cuenta), en USD.
-- Lo fija el superadmin; el presupuesto que el cliente configura en «Consumo de IA» solo puede ser más estricto.
-- NULL = sin tope (lo de antes). La prueba gratis usa TRIAL_AI_USD.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS ai_usd_per_month numeric(12, 4) CHECK (ai_usd_per_month IS NULL OR ai_usd_per_month >= 0);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_usd_override numeric(12, 4) CHECK (ai_usd_override IS NULL OR ai_usd_override >= 0);
