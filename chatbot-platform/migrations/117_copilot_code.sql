-- Copiloto: propuestas que se confirman con el código de verificación (las acciones delicadas que en el panel piden el
-- código: equipo, webhooks, avisos con datos a números o correos de fuera, borrar un contacto, exportar…). Sin el código
-- escrito en la tarjeta no se ejecutan.
ALTER TABLE copilot_actions DROP CONSTRAINT IF EXISTS copilot_actions_risk_check;
ALTER TABLE copilot_actions ADD CONSTRAINT copilot_actions_risk_check CHECK (risk IN ('read', 'reversible', 'confirm', 'code'));
