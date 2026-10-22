-- Invitaciones de equipo: el administrador invita por correo y la persona entra sola (con su contraseña o con Google).
-- Solo se guarda el hash del enlace. Una invitación viva por correo y cuenta.
CREATE TABLE account_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email            text NOT NULL,
  name             text NOT NULL DEFAULT '',
  role             text NOT NULL CHECK (role IN ('admin', 'agent')),
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_invitations_account_idx ON account_invitations (account_id);
CREATE INDEX account_invitations_invited_by_idx ON account_invitations (invited_by);
CREATE INDEX account_invitations_accepted_user_idx ON account_invitations (accepted_user_id);
CREATE INDEX account_invitations_email_idx ON account_invitations (lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX account_invitations_one_pending ON account_invitations (account_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Quien entra por invitación también acepta los términos.
ALTER TABLE terms_acceptances DROP CONSTRAINT terms_acceptances_source_check;
ALTER TABLE terms_acceptances ADD CONSTRAINT terms_acceptances_source_check CHECK (source IN ('signup', 'google', 'reaccept', 'invite'));
