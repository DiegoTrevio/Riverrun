-- Avisos al superadmin que no son urgentes: se juntan en un solo correo al día en lugar de uno por evento.
CREATE TABLE superadmin_digest (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX superadmin_digest_pending_idx ON superadmin_digest (created_at) WHERE sent_at IS NULL;
CREATE INDEX superadmin_digest_account_idx ON superadmin_digest (account_id);
