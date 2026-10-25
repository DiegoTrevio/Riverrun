-- Datos propios de los clientes de cada negocio («Datos de tus clientes»): cada campo con su etiqueta y su tipo. Los
-- valores siguen en contacts.data como texto, así que el CHECK de contacts no cambia. Borrar un campo no borra lo guardado.
CREATE TABLE IF NOT EXISTS contact_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  type text NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'number', 'date', 'option', 'email', 'phone')),
  options jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, key)
);

-- Recordatorio de cita fuera de la ventana de 24 h de WhatsApp oficial: la plantilla aprobada con sus variables.
ALTER TABLE services ADD COLUMN IF NOT EXISTS reminder_wa_template jsonb;
