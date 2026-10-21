-- Cobro fallido y retención de datos.

-- Recordatorios de un cobro fallido ya enviados (0 = ninguno, 1 = a los 3 días, 2 = un día antes de pausar).
ALTER TABLE subscriptions ADD COLUMN dunning_step int NOT NULL DEFAULT 0;

-- Pausa automática (prueba vencida o falta de pago): desde cuándo y por qué. Una pausa manual no la pone, así que nunca
-- se borra sola. keep_data = el superadmin decidió conservarla.
ALTER TABLE accounts
  ADD COLUMN paused_at          timestamptz,
  ADD COLUMN pause_reason       text NOT NULL DEFAULT '' CHECK (pause_reason IN ('', 'trial', 'payment')),
  ADD COLUMN deletion_warned_at timestamptz,
  ADD COLUMN keep_data          boolean NOT NULL DEFAULT false;
CREATE INDEX accounts_paused_at_idx ON accounts (paused_at) WHERE paused_at IS NOT NULL;

-- Cualquier reactivación (pago, superadmin, lo que sea) cancela el conteo para borrar la cuenta.
CREATE FUNCTION accounts_clear_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'paused' THEN
    NEW.paused_at := NULL;
    NEW.pause_reason := '';
    NEW.deletion_warned_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_clear_pause BEFORE UPDATE OF status ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_clear_pause();
