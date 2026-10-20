-- Estadísticas diarias de las redes conectadas por Zernio (seguidores, alcance, impresiones, interacción) y salud de
-- cada cuenta (si hay que reconectarla, cuándo vence su permiso). Los días son los de Zernio (UTC).
CREATE TABLE IF NOT EXISTS social_account_stats (
  social_account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  day               date NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = sin dato (no es cero).
  followers         integer,
  impressions       bigint,
  reach             bigint,
  engagement        bigint,
  views             bigint,
  clicks            bigint,
  posts             integer,
  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (social_account_id, day)
);
CREATE INDEX IF NOT EXISTS social_account_stats_account_idx ON social_account_stats (account_id, day);

ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS stats_synced_at timestamptz;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS stats_error text NOT NULL DEFAULT '';
-- Caída: desde cuándo y cuándo se avisó (un aviso por caída).
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS down_since timestamptz;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS down_notified_at timestamptz;
-- Fecha de vencimiento del permiso de la que ya se avisó (un aviso por fecha).
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS token_warned_for timestamptz;
CREATE INDEX IF NOT EXISTS social_accounts_stats_due_idx ON social_accounts (stats_synced_at NULLS FIRST) WHERE status = 'active';
-- Las que ya estaban caídas al instalar esto no avisan todas de golpe.
UPDATE social_accounts SET down_since = coalesce(down_since, updated_at), down_notified_at = coalesce(down_notified_at, now()) WHERE status <> 'active';
