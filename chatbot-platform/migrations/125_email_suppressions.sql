-- Correos a los que un negocio ya no puede enviar campañas: se dieron de baja, rebotaron o se quejaron de spam.
-- Es por cuenta y por dirección (no por contacto): aunque la base se vuelva a importar, o la persona esté en otro canal de
-- correo del negocio, la dirección sigue fuera. Nunca se borra al importar.
CREATE TABLE IF NOT EXISTS email_suppressions (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address    text NOT NULL CHECK (address = lower(address) AND address <> ''),
  reason     text NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained')),
  detail     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, address)
);
