-- Plantillas de WhatsApp (API oficial por Zernio): las aprueba Meta y son lo único que se puede enviar fuera de la
-- ventana de 24 horas. Cada una es de un número (cuenta conectada) del negocio.
CREATE TABLE IF NOT EXISTS wa_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  social_account_id  uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  zernio_template_id text NOT NULL DEFAULT '',
  name               text NOT NULL,
  language           text NOT NULL,
  category           text NOT NULL DEFAULT 'UTILITY',
  status             text NOT NULL DEFAULT 'PENDING',
  components         jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejection_reason   text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (social_account_id, name, language)
);
CREATE INDEX IF NOT EXISTS wa_templates_account_idx ON wa_templates (account_id);

-- Fuera de 24 h, una campaña por WhatsApp oficial sale con su plantilla aprobada (y sus variables).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS wa_template jsonb;

-- Opciones de la conexión (p. ej. WhatsApp: seguir usando la app WhatsApp Business en el teléfono).
ALTER TABLE zernio_connect_sessions ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb;
