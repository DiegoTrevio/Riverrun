-- Cobros que registra un agente (ID-11): quedan por aprobar hasta que un administrador los revisa. Sin aprobar no salen
-- recordatorios, el asistente no los menciona y un pago recurrente no genera cobros. Lo que ya existía y lo que registra
-- un administrador, la API o el sistema queda aprobado (por omisión, al momento de crearse).

ALTER TABLE receivables ADD COLUMN IF NOT EXISTS approved_at timestamptz DEFAULT now();
ALTER TABLE receivables ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE receivable_plans ADD COLUMN IF NOT EXISTS approved_at timestamptz DEFAULT now();
ALTER TABLE receivable_plans ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS receivables_approved_by_idx ON receivables (approved_by);
CREATE INDEX IF NOT EXISTS receivable_plans_approved_by_idx ON receivable_plans (approved_by);
