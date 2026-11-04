-- Copiloto encendido por omisión: en las cuentas nuevas y en las que ya existen. Se sigue pudiendo apagar cuenta por
-- cuenta (Perfiles de negocio) y en toda la plataforma (COPILOT_ENABLED=false). Sus topes de gasto no cambian.
ALTER TABLE accounts ALTER COLUMN copilot_enabled SET DEFAULT true;
UPDATE accounts SET copilot_enabled = true WHERE NOT copilot_enabled;
