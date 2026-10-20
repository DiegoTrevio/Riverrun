-- Agentes creados con el asistente: nacen apagados (se prueban en el simulador) y se encienden solos la primera vez que
-- una de sus conexiones queda conectada. La marca se borra al encenderse (solo o a mano) y al apagarlo a mano: nunca
-- vuelve a encender un agente que alguien apagó.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS start_on_connect boolean NOT NULL DEFAULT false;
-- Reintentos del asistente (respuesta perdida, doble clic): la misma solicitud no crea dos agentes.
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS creation_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS chatbots_creation_ref_idx ON chatbots (account_id, creation_ref) WHERE creation_ref IS NOT NULL;
