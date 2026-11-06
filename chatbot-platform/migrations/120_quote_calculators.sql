-- Calculadora de cotizaciones (para cualquier giro): la configuración que convierte los datos del cliente en conceptos
-- con cantidad y precio. La lista de precios gana familia y atributos para que la calculadora encuentre cada precio
-- (p. ej. familia «panel» con producto, altura y escalón). Cada cotización guarda con qué calculadora, versión y datos
-- salió, para reproducirla.
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS family text NOT NULL DEFAULT '';
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE price_items ADD CONSTRAINT price_items_family_ck CHECK (length(family) <= 60);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE price_items ADD CONSTRAINT price_items_attributes_ck CHECK (jsonb_typeof(attributes) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS price_items_family_idx ON price_items (account_id, family) WHERE family <> '';

CREATE TABLE IF NOT EXISTS quote_calculators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  -- Plantilla por giro de la que salió (solo informativo: la copia no queda ligada).
  template_key  text NOT NULL DEFAULT '' CHECK (length(template_key) <= 60),
  definition    jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  -- Sube con cada cambio de la definición; la cotización guarda con cuál salió.
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_calculators_account_idx ON quote_calculators (account_id);

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS calculator_id uuid REFERENCES quote_calculators(id) ON DELETE SET NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS calculator_version integer;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS calculator_inputs jsonb;
CREATE INDEX IF NOT EXISTS quotes_calculator_id_idx ON quotes (calculator_id);
