-- Archivos para automatizaciones y secuencias (PDF, Word, Excel, audio, video…). Aparte del catálogo de fotos: la IA nunca los elige.
CREATE TABLE attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  mime        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('image','document','audio','video')),
  size_bytes  integer NOT NULL CHECK (size_bytes >= 0),
  file_path   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_account_idx ON attachments (account_id, created_at DESC);
