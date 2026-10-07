-- Canal de correo: IMAP para recibir y SMTP para responder, con el hilo guardado para responder en la misma conversación.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('whatsapp', 'telegram', 'messenger', 'instagram', 'webchat', 'email', 'playground'));

CREATE TABLE email_threads (
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  address     text NOT NULL,               -- correo del cliente (minúsculas)
  subject     text NOT NULL DEFAULT '',
  message_id  text NOT NULL DEFAULT '',    -- Message-ID del último correo recibido (para In-Reply-To)
  refs        text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, address)
);
