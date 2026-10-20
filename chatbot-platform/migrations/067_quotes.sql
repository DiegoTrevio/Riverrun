-- Cotizaciones: el negocio sube su formato en Word, arma una lista de precios (exactos o aproximados) y el agente
-- entrega al cliente un PDF que dice si es APROXIMADA o FINAL. Las aproximadas salen solas; las finales las aprueba el
-- equipo. Los montos los calcula siempre el sistema (en centavos), nunca la IA.

-- Ajustes de la cuenta: moneda, IVA, vigencia, leyendas y el siguiente folio.
CREATE TABLE IF NOT EXISTS quote_settings (
  account_id          uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  currency            text NOT NULL DEFAULT 'MXN',
  iva_rate            numeric(5, 4) NOT NULL DEFAULT 0.16 CHECK (iva_rate >= 0 AND iva_rate < 1),
  prices_include_iva  boolean NOT NULL DEFAULT false,
  validity_days       integer NOT NULL DEFAULT 15 CHECK (validity_days BETWEEN 1 AND 365),
  legend_approx       text NOT NULL DEFAULT 'Esta cotización es aproximada y puede cambiar. El precio final se confirma al revisar los detalles.',
  legend_final        text NOT NULL DEFAULT 'Cotización final. Los precios se respetan durante la vigencia indicada.',
  -- Datos del negocio que se imprimen en el formato ({{negocio.*}}); el nombre vacío usa el de la cuenta.
  business_name       text NOT NULL DEFAULT '',
  business_phone      text NOT NULL DEFAULT '',
  business_email      text NOT NULL DEFAULT '',
  business_address    text NOT NULL DEFAULT '',
  folio_prefix        text NOT NULL DEFAULT 'COT-',
  next_folio          integer NOT NULL DEFAULT 1 CHECK (next_folio >= 1),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Formatos en Word. Cada subida es una versión nueva; las anteriores se archivan y nunca se sobrescriben, para poder
-- volver a generar una cotización con el formato con que se hizo.
CREATE TABLE IF NOT EXISTS quote_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  file_path     text NOT NULL,
  sha256        text NOT NULL,
  size_bytes    integer NOT NULL,
  placeholders  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name, version)
);
CREATE INDEX IF NOT EXISTS quote_templates_created_by_idx ON quote_templates (created_by);

-- Lista de precios. Modos: exacto, «desde», rango (mínimo a máximo) o por confirmar (sin precio).
CREATE TABLE IF NOT EXISTS price_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code         text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,40}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '',
  unit         text NOT NULL DEFAULT 'servicio',
  price_mode   text NOT NULL DEFAULT 'exact' CHECK (price_mode IN ('exact', 'from', 'range', 'tbd')),
  price_min    bigint CHECK (price_min IS NULL OR price_min >= 0),
  price_max    bigint CHECK (price_max IS NULL OR price_max >= 0),
  iva_mode     text NOT NULL DEFAULT 'plus' CHECK (iva_mode IN ('plus', 'included', 'exempt')),
  active       boolean NOT NULL DEFAULT true,
  sort         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code),
  CONSTRAINT price_items_mode_ck CHECK (
    (price_mode = 'tbd' AND price_min IS NULL AND price_max IS NULL)
    OR (price_mode IN ('exact', 'from') AND price_min IS NOT NULL AND price_max IS NULL)
    OR (price_mode = 'range' AND price_min IS NOT NULL AND price_max IS NOT NULL AND price_min < price_max)
  )
);

-- Cotizaciones. Los montos van en centavos; mínimo y máximo coinciden cuando todo es exacto.
CREATE TABLE IF NOT EXISTS quotes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chatbot_id         uuid REFERENCES chatbots(id) ON DELETE SET NULL,
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  request_id         bigint REFERENCES conversation_requests(id) ON DELETE SET NULL,
  pipeline_card_id   bigint REFERENCES pipeline_cards(id) ON DELETE SET NULL,
  template_id        uuid REFERENCES quote_templates(id) ON DELETE SET NULL,
  folio              text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('approximate', 'final')),
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'rejected', 'expired', 'failed')),
  source             text NOT NULL DEFAULT 'bot' CHECK (source IN ('bot', 'panel')),
  currency           text NOT NULL DEFAULT 'MXN',
  iva_rate           numeric(5, 4) NOT NULL,
  subtotal_min       bigint NOT NULL DEFAULT 0,
  subtotal_max       bigint NOT NULL DEFAULT 0,
  iva_min            bigint NOT NULL DEFAULT 0,
  iva_max            bigint NOT NULL DEFAULT 0,
  total_min          bigint NOT NULL DEFAULT 0,
  total_max          bigint NOT NULL DEFAULT 0,
  open_ended         boolean NOT NULL DEFAULT false,
  has_tbd            boolean NOT NULL DEFAULT false,
  notes              text NOT NULL DEFAULT '',
  valid_until        date NOT NULL,
  customer_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
  docx_path          text,
  pdf_path           text,
  pdf_sha256         text,
  approved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at        timestamptz,
  sent_at            timestamptz,
  rejected_reason    text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, folio),
  CHECK (subtotal_min <= subtotal_max AND iva_min <= iva_max AND total_min <= total_max)
);
CREATE INDEX IF NOT EXISTS quotes_account_created_idx ON quotes (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_chatbot_idx ON quotes (chatbot_id);
CREATE INDEX IF NOT EXISTS quotes_conversation_idx ON quotes (conversation_id);
CREATE INDEX IF NOT EXISTS quotes_contact_idx ON quotes (contact_id);
CREATE INDEX IF NOT EXISTS quotes_pipeline_card_idx ON quotes (pipeline_card_id);
CREATE INDEX IF NOT EXISTS quotes_template_idx ON quotes (template_id);
CREATE INDEX IF NOT EXISTS quotes_approved_by_idx ON quotes (approved_by);
CREATE INDEX IF NOT EXISTS quotes_request_idx ON quotes (request_id);
-- Una sola cotización abierta (en preparación o por aprobar) por solicitud.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_open_request_uq ON quotes (request_id)
  WHERE status IN ('draft', 'pending_approval', 'approved');
CREATE INDEX IF NOT EXISTS quotes_expiry_idx ON quotes (valid_until) WHERE status IN ('pending_approval', 'approved', 'sent');

-- Renglones: guardan el precio con que se cotizó, para que cambiar la lista no altere cotizaciones anteriores.
CREATE TABLE IF NOT EXISTS quote_lines (
  id              bigserial PRIMARY KEY,
  quote_id        uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  price_item_id   uuid REFERENCES price_items(id) ON DELETE SET NULL,
  code            text NOT NULL DEFAULT '',
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  unit            text NOT NULL DEFAULT 'servicio',
  qty             numeric(12, 3) NOT NULL CHECK (qty > 0),
  price_mode      text NOT NULL CHECK (price_mode IN ('exact', 'from', 'range', 'tbd')),
  price_min       bigint,
  price_max       bigint,
  iva_mode        text NOT NULL CHECK (iva_mode IN ('plus', 'included', 'exempt')),
  amount_min      bigint,
  amount_max      bigint,
  edited_by_team  boolean NOT NULL DEFAULT false,
  UNIQUE (quote_id, position)
);
CREATE INDEX IF NOT EXISTS quote_lines_price_item_idx ON quote_lines (price_item_id);

-- Historial de cada cotización (creación, envío, aprobación, rechazo, edición, vencimiento, error).
CREATE TABLE IF NOT EXISTS quote_events (
  id          bigserial PRIMARY KEY,
  quote_id    uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  type        text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_events_quote_idx ON quote_events (quote_id, created_at);
CREATE INDEX IF NOT EXISTS quote_events_user_idx ON quote_events (user_id);
-- La operación del motor que creó la cotización: un reintento tras un reinicio la reutiliza en vez de duplicarla.
CREATE INDEX IF NOT EXISTS quote_events_operation_idx ON quote_events ((detail->>'operation')) WHERE type = 'created';
