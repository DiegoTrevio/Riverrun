-- Fotos y documentos que envían los clientes. El archivo se guarda tal como llegó (bytes originales) y su huella SHA-256 permite comprobarlo.
-- Un mensaje tiene como máximo un archivo. El archivo vive en UPLOADS_DIR/inbound/<cuenta>/ y se borra junto con el mensaje (retención o borrado del contacto).
CREATE TABLE IF NOT EXISTS message_media (
  message_id   bigint PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('image', 'document')),
  mime         text NOT NULL DEFAULT 'application/octet-stream',
  file_name    text NOT NULL DEFAULT '',
  size_bytes   integer NOT NULL CHECK (size_bytes >= 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  file_path    text NOT NULL CHECK (file_path LIKE 'inbound/%' AND file_path NOT LIKE '%..%'),
  complete     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
