-- Canal Zernio (API unificada de mensajes): amplía los tipos de canal permitidos.
-- Va después de 022_email para conservar todos los tipos anteriores.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
  CHECK (type IN ('whatsapp', 'telegram', 'messenger', 'instagram', 'webchat', 'email', 'playground', 'zernio'));
