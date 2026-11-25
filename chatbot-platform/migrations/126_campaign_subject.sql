-- Campañas por correo: el asunto del correo (las de WhatsApp y redes no lo usan).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT '';
