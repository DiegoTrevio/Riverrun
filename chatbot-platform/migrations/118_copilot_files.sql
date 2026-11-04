-- Copiloto: archivos adjuntos al pedido (fotos de la cámara o la galería, PDF, CSV, documentos). Son de una persona en
-- una conversación, viven 24 horas (COPILOT_FILE_HOURS) y se borran con la conversación, con los datos de un cliente y
-- con la cuenta. Las herramientas solo reciben su id; el servidor arma la subida a la ruta del panel que corresponda.
CREATE TABLE copilot_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id  uuid NOT NULL REFERENCES copilot_threads(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  mime       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('image', 'document')),
  size_bytes int NOT NULL,
  sha256     text NOT NULL,
  file_path  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX copilot_files_thread_idx ON copilot_files (thread_id, created_at);
CREATE INDEX copilot_files_account_idx ON copilot_files (account_id, expires_at);
CREATE INDEX copilot_files_expires_idx ON copilot_files (expires_at);

ALTER TABLE copilot_messages ADD COLUMN files uuid[] NOT NULL DEFAULT '{}';
