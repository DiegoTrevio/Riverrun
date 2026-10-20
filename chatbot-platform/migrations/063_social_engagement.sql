-- Comentarios y reseñas de las redes conectadas por Zernio (Instagram, Facebook, X, LinkedIn, YouTube, Google…): llegan
-- por el webhook de la plataforma o por la revisión diaria, y el negocio los contesta (o la IA sugiere la respuesta).

-- Publicación de una red en la que hay comentarios (una fila por publicación y cuenta conectada).
CREATE TABLE IF NOT EXISTS social_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  social_account_id   uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform_post_id    text NOT NULL,
  url                 text NOT NULL DEFAULT '',
  caption             text NOT NULL DEFAULT '',
  thumbnail           text NOT NULL DEFAULT '',
  comment_count       integer NOT NULL DEFAULT 0,
  created_at_platform timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (social_account_id, platform_post_id)
);
CREATE INDEX IF NOT EXISTS social_posts_account_idx ON social_posts (account_id);

CREATE TABLE IF NOT EXISTS social_comments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  social_account_id        uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  post_id                  uuid REFERENCES social_posts(id) ON DELETE CASCADE,
  platform                 text NOT NULL,
  platform_post_id         text NOT NULL,
  comment_id               text NOT NULL,
  parent_id                text NOT NULL DEFAULT '',
  author                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_own                   boolean NOT NULL DEFAULT false,
  text                     text NOT NULL DEFAULT '',
  created_at_platform      timestamptz,
  status                   text NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'respondido', 'oculto', 'eliminado', 'ignorado')),
  sentiment                text NOT NULL DEFAULT '' CHECK (sentiment IN ('', 'positive', 'neutral', 'negative')),
  needs_human              boolean NOT NULL DEFAULT false,
  ai_suggestion            text NOT NULL DEFAULT '',
  reply_text               text NOT NULL DEFAULT '',
  reply_comment_id         text NOT NULL DEFAULT '',
  reply_source             text NOT NULL DEFAULT '' CHECK (reply_source IN ('', 'human', 'suggested', 'auto', 'external')),
  replied_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  replied_at               timestamptz,
  private_reply_at         timestamptz,
  private_reply_message_id text NOT NULL DEFAULT '',
  liked                    boolean NOT NULL DEFAULT false,
  -- Datos de la red para actuar sobre el comentario (Bluesky: cid/rootUri/rootCid; likeUri; lo que la red permite).
  meta                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified_at              timestamptz,
  received_at              timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (social_account_id, comment_id)
);
CREATE INDEX IF NOT EXISTS social_comments_account_idx ON social_comments (account_id, status, created_at_platform DESC);
CREATE INDEX IF NOT EXISTS social_comments_post_idx ON social_comments (post_id);
CREATE INDEX IF NOT EXISTS social_comments_user_idx ON social_comments (replied_by);

CREATE TABLE IF NOT EXISTS social_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  social_account_id   uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform            text NOT NULL,
  review_id           text NOT NULL,
  author              jsonb NOT NULL DEFAULT '{}'::jsonb,
  rating              smallint CHECK (rating BETWEEN 1 AND 5),
  recommendation      text NOT NULL DEFAULT '',
  location_name       text NOT NULL DEFAULT '',
  url                 text NOT NULL DEFAULT '',
  text                text NOT NULL DEFAULT '',
  created_at_platform timestamptz,
  status              text NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'respondido', 'ignorado')),
  sentiment           text NOT NULL DEFAULT '' CHECK (sentiment IN ('', 'positive', 'neutral', 'negative')),
  needs_human         boolean NOT NULL DEFAULT false,
  ai_suggestion       text NOT NULL DEFAULT '',
  reply_text          text NOT NULL DEFAULT '',
  reply_source        text NOT NULL DEFAULT '' CHECK (reply_source IN ('', 'human', 'suggested', 'auto', 'external')),
  replied_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  replied_at          timestamptz,
  notified_at         timestamptz,
  received_at         timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (social_account_id, review_id)
);
CREATE INDEX IF NOT EXISTS social_reviews_account_idx ON social_reviews (account_id, status, created_at_platform DESC);
CREATE INDEX IF NOT EXISTS social_reviews_user_idx ON social_reviews (replied_by);

-- Última revisión de comentarios y reseñas de la cuenta (la diaria; los nuevos llegan por el webhook).
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS engagement_synced_at timestamptz;
