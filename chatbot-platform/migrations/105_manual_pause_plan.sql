-- PAY-8: lo que el superadministrador decide a mano no lo deshace un pago. La pausa a mano guarda pause_reason = 'manual'
-- (un pago, la conciliación o un aviso no la quitan: solo él), y el plan que él asigna guarda plan_source = 'manual' (la
-- suscripción no lo pisa; si dice otro plan, se le avisa). Cuando el dueño cambia de plan desde Mi plan, vuelve a 'provider'.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_pause_reason_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_pause_reason_check CHECK (pause_reason IN ('', 'trial', 'payment', 'dispute', 'card', 'manual'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS plan_source text NOT NULL DEFAULT 'provider' CHECK (plan_source IN ('provider', 'manual'));
