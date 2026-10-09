-- Varios números de WhatsApp por cuenta con reparto de carga.
--  campaigns.channel_ids: números adicionales (además de channel_id) desde los que sale una campaña; cada cliente recibe
--                         el mensaje desde el número con el que ya hablaba y cada número lleva su propio ritmo y tope diario.
--  wa_pools:              enlace público que reparte a los clientes nuevos entre varios números (wa.me).
ALTER TABLE campaigns ADD COLUMN channel_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE wa_pools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  token       text NOT NULL UNIQUE,
  strategy    text NOT NULL DEFAULT 'least_busy' CHECK (strategy IN ('round_robin', 'least_busy')),
  channel_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  message     text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  rr_counter  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_pools_account_idx ON wa_pools (account_id);

CREATE TABLE wa_pool_hits (
  pool_id    uuid NOT NULL REFERENCES wa_pools(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day        date NOT NULL DEFAULT current_date,
  hits       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (pool_id, channel_id, day)
);
