-- Cobro automático: planes que define el operador, suscripción de cada cuenta y registro de avisos de los proveedores.
CREATE TABLE plans (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z0-9_-]{1,40}$'),
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  price_cents     integer NOT NULL CHECK (price_cents > 0),
  currency        text NOT NULL DEFAULT 'MXN',
  stripe_price_id text NOT NULL DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  account_id               uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  provider                 text NOT NULL CHECK (provider IN ('stripe', 'mercadopago')),
  provider_customer_id     text NOT NULL DEFAULT '',
  provider_subscription_id text NOT NULL DEFAULT '',
  plan_key                 text NOT NULL DEFAULT '',
  -- incomplete = pago iniciado | active = al corriente | past_due = cobro fallido (en gracia) | canceled
  status                   text NOT NULL DEFAULT 'incomplete' CHECK (status IN ('incomplete', 'active', 'past_due', 'canceled')),
  current_period_end       timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  past_due_since           timestamptz,
  -- Cuándo el sistema pausó la cuenta por falta de pago (si el superadmin la reactiva a mano, no se vuelve a pausar).
  access_ended_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_provider_sub_idx ON subscriptions (provider, provider_subscription_id) WHERE provider_subscription_id <> '';

CREATE TABLE billing_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  type        text NOT NULL,
  account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
