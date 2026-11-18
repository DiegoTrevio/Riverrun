-- Idioma de cada persona del equipo (el mismo que eligió para el panel): los correos y avisos que le llegan salen en él.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang text NOT NULL DEFAULT 'es' CHECK (lang IN ('es', 'en'));
