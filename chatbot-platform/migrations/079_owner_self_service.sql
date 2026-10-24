-- El dueño borra su propia cuenta: lo pide, lo confirma desde su correo y se borra 7 días después (puede cancelarlo
-- mientras tanto).
ALTER TABLE accounts
  ADD COLUMN deletion_requested_at  timestamptz,
  ADD COLUMN deletion_scheduled_for timestamptz;
CREATE INDEX accounts_deletion_scheduled_idx ON accounts (deletion_scheduled_for) WHERE deletion_scheduled_for IS NOT NULL;
