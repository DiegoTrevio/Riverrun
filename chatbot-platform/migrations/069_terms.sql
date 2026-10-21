-- Constancia de que cada persona aceptó los términos y el aviso de privacidad: qué versión, desde dónde y cuándo.
-- Si se borra el usuario o la cuenta, la constancia se conserva (con el correo) como prueba de la aceptación.
CREATE TABLE terms_acceptances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,
  email         text NOT NULL,
  terms_version text NOT NULL DEFAULT '',
  terms_url     text NOT NULL DEFAULT '',
  privacy_url   text NOT NULL DEFAULT '',
  ip            text NOT NULL DEFAULT '',
  user_agent    text NOT NULL DEFAULT '',
  -- signup = formulario de registro | google = registro con Google | reaccept = aceptó una versión nueva
  source        text NOT NULL CHECK (source IN ('signup', 'google', 'reaccept')),
  accepted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terms_acceptances_user_idx ON terms_acceptances (user_id, accepted_at DESC);
CREATE INDEX terms_acceptances_account_idx ON terms_acceptances (account_id) WHERE account_id IS NOT NULL;
