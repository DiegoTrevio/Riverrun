-- Canal Zernio (API unificada de mensajes): amplía los tipos de canal permitidos.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
  CHECK (type IN ('whatsapp', 'telegram', 'messenger', 'instagram', 'webchat', 'playground', 'zernio'));
