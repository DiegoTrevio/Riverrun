-- Publicaciones en las redes conectadas por Zernio: el negocio escribe una vez, elige cuentas y publica ya o programa.
-- Cada red (destino) tiene su propio estado y enlace. social_posts (063) es otra cosa: las publicaciones con comentarios.
CREATE TABLE IF NOT EXISTS social_publications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Una por formulario: enviarlo dos veces devuelve la misma publicación.
  client_ref     uuid,
  status         text NOT NULL DEFAULT 'borrador'
                 CHECK (status IN ('borrador', 'enviando', 'programada', 'publicando', 'publicada', 'parcial', 'fallida', 'cancelada')),
  text           text NOT NULL DEFAULT '',
  -- [{url, type, name, size}] (archivos ya subidos a Zernio).
  media          jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for  timestamptz,
  timezone       text NOT NULL DEFAULT '',
  zernio_post_id text,
  -- Idempotency-Key = pub-<id>-<send_seq>: un reintento del mismo envío no publica dos veces.
  send_seq       integer NOT NULL DEFAULT 0,
  sent_at        timestamptz,
  -- Apartada mientras se habla con Zernio (dos clics no la envían dos veces).
  busy_until     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  error          text NOT NULL DEFAULT '',
  notified_at    timestamptz,
  published_at   timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS social_publications_zernio_idx ON social_publications (zernio_post_id) WHERE zernio_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_publications_user_idx ON social_publications (created_by);
CREATE INDEX IF NOT EXISTS social_publications_open_idx ON social_publications (status, scheduled_for) WHERE status IN ('enviando', 'programada', 'publicando');

CREATE TABLE IF NOT EXISTS social_publication_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id    uuid NOT NULL REFERENCES social_publications(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Desconectar una red borra su fila: la publicación conserva su historia con las copias de abajo.
  social_account_id uuid REFERENCES social_accounts(id) ON DELETE SET NULL,
  zernio_account_id text NOT NULL,
  platform          text NOT NULL,
  username          text NOT NULL DEFAULT '',
  text_override     text,
  -- Lo propio de la red: título (YouTube, Pinterest, Reddit), enlace (Pinterest)…
  options           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'publicando', 'publicada', 'fallida', 'cancelada', 'eliminada')),
  platform_post_id  text NOT NULL DEFAULT '',
  url               text NOT NULL DEFAULT '',
  error             text NOT NULL DEFAULT '',
  published_at      timestamptz,
  status_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id, zernio_account_id)
);
CREATE INDEX IF NOT EXISTS social_publication_targets_account_idx ON social_publication_targets (account_id);
CREATE INDEX IF NOT EXISTS social_publication_targets_social_idx ON social_publication_targets (social_account_id, created_at);
