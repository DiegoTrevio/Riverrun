-- Planes privados: un plan con public = false no sale en /precios ni en el registro, y solo lo contrata la cuenta a la que
-- el superadmin se lo asignó (accounts.plan). Antes todo plan activo se publicaba y cualquiera podía contratarlo.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT true;
