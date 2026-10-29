-- Copiloto: el ayudante con IA que hace cambios en el panel por quien se lo pide. Cada hilo es de una persona y de una
-- cuenta. Cada turno guarda sus pasos, y cada acción guarda lo que hizo, con la foto de antes y la de después para
-- deshacerla, o la propuesta que espera confirmación. `rev` sale de una secuencia en cada alta o cambio: es el cursor
-- con el que el panel pide solo lo nuevo. Se borra a los 90 días; al borrar los datos de un cliente se vacía su texto.
ALTER TABLE accounts ADD COLUMN copilot_enabled boolean NOT NULL DEFAULT false;

CREATE SEQUENCE copilot_rev;
CREATE FUNCTION copilot_next_rev() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.rev := nextval('copilot_rev');
  RETURN NEW;
END $$;

CREATE TABLE copilot_threads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rev        bigint NOT NULL DEFAULT 0
);
CREATE INDEX copilot_threads_user_idx ON copilot_threads (user_id, account_id, updated_at DESC);
CREATE INDEX copilot_threads_account_idx ON copilot_threads (account_id);
CREATE INDEX copilot_threads_updated_idx ON copilot_threads (updated_at);

CREATE TABLE copilot_turns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           uuid NOT NULL REFERENCES copilot_threads(id) ON DELETE CASCADE,
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'stopped', 'failed', 'interrupted')),
  page                jsonb NOT NULL DEFAULT '{}',
  step_label          text NOT NULL DEFAULT '',
  model               text NOT NULL DEFAULT '',
  steps               int NOT NULL DEFAULT 0,
  tool_calls          int NOT NULL DEFAULT 0,
  input_tokens        int NOT NULL DEFAULT 0,
  cached_tokens       int NOT NULL DEFAULT 0,
  output_tokens       int NOT NULL DEFAULT 0,
  cost_usd            numeric(14, 6) NOT NULL DEFAULT 0,
  tainted             boolean NOT NULL DEFAULT false,      -- leyó texto escrito por clientes
  contact_ids         uuid[] NOT NULL DEFAULT '{}',        -- contactos que tocó (para borrarlos con el cliente)
  error               text NOT NULL DEFAULT '',
  cancel_requested_at timestamptz,
  heartbeat_at        timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  rev                 bigint NOT NULL DEFAULT 0
);
-- Un turno a la vez por hilo y por persona.
CREATE UNIQUE INDEX copilot_turns_running_thread ON copilot_turns (thread_id) WHERE status = 'running';
CREATE UNIQUE INDEX copilot_turns_running_user ON copilot_turns (user_id) WHERE status = 'running';
CREATE INDEX copilot_turns_thread_idx ON copilot_turns (thread_id, rev);
CREATE INDEX copilot_turns_user_idx ON copilot_turns (user_id, started_at);
CREATE INDEX copilot_turns_account_idx ON copilot_turns (account_id, started_at);
CREATE INDEX copilot_turns_contacts_idx ON copilot_turns USING gin (contact_ids);

CREATE TABLE copilot_messages (
  id           bigserial PRIMARY KEY,
  thread_id    uuid NOT NULL REFERENCES copilot_threads(id) ON DELETE CASCADE,
  turn_id      uuid REFERENCES copilot_turns(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'event')),
  content      text NOT NULL DEFAULT '',
  tool_calls   jsonb,                                       -- [{id, name, arguments}] cuando el modelo pidió herramientas
  tool_call_id text,
  refs         uuid[] NOT NULL DEFAULT '{}',                -- acciones a las que se refiere el mensaje («Cambiar esto»)
  redacted     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rev          bigint NOT NULL DEFAULT 0
);
CREATE INDEX copilot_messages_thread_idx ON copilot_messages (thread_id, id);
CREATE INDEX copilot_messages_rev_idx ON copilot_messages (thread_id, rev);
CREATE INDEX copilot_messages_turn_idx ON copilot_messages (turn_id);

CREATE TABLE copilot_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES copilot_threads(id) ON DELETE CASCADE,
  turn_id      uuid NOT NULL REFERENCES copilot_turns(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL DEFAULT '',
  tool         text NOT NULL,
  args         jsonb NOT NULL DEFAULT '{}',
  args_hash    text NOT NULL DEFAULT '',
  risk         text NOT NULL CHECK (risk IN ('read', 'reversible', 'confirm')),
  risk_reasons jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL CHECK (status IN ('proposed', 'executing', 'done', 'failed', 'declined', 'expired', 'undoing', 'undone', 'unknown')),
  title        text NOT NULL DEFAULT '',
  preview      jsonb,                                       -- lo que verá quien confirma, armado por el servidor
  result       jsonb,
  links        jsonb NOT NULL DEFAULT '[]',
  before       jsonb,
  after        jsonb,
  undo         jsonb,                                       -- receta para deshacer (comprobación + pasos)
  undo_until   timestamptz,
  contact_ids  uuid[] NOT NULL DEFAULT '{}',
  error        text NOT NULL DEFAULT '',
  expires_at   timestamptz,
  confirmed_at timestamptz,
  executed_at  timestamptz,
  undone_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  rev          bigint NOT NULL DEFAULT 0
);
CREATE INDEX copilot_actions_thread_idx ON copilot_actions (thread_id, created_at);
CREATE INDEX copilot_actions_rev_idx ON copilot_actions (thread_id, rev);
CREATE INDEX copilot_actions_turn_idx ON copilot_actions (turn_id);
CREATE INDEX copilot_actions_account_idx ON copilot_actions (account_id, created_at DESC);
CREATE INDEX copilot_actions_user_idx ON copilot_actions (user_id);
CREATE INDEX copilot_actions_proposed_idx ON copilot_actions (expires_at) WHERE status = 'proposed';
CREATE INDEX copilot_actions_contacts_idx ON copilot_actions USING gin (contact_ids);

CREATE TRIGGER copilot_threads_rev BEFORE INSERT OR UPDATE ON copilot_threads FOR EACH ROW EXECUTE FUNCTION copilot_next_rev();
CREATE TRIGGER copilot_turns_rev BEFORE INSERT OR UPDATE ON copilot_turns FOR EACH ROW EXECUTE FUNCTION copilot_next_rev();
CREATE TRIGGER copilot_messages_rev BEFORE INSERT OR UPDATE ON copilot_messages FOR EACH ROW EXECUTE FUNCTION copilot_next_rev();
CREATE TRIGGER copilot_actions_rev BEFORE INSERT OR UPDATE ON copilot_actions FOR EACH ROW EXECUTE FUNCTION copilot_next_rev();

-- Precio del modelo del Copiloto (por millón de tokens, USD): con límites de gasto, una llamada sin precio no se reserva.
INSERT INTO ai_prices (model, input_per_mtok, cached_per_mtok, output_per_mtok, per_audio_minute)
VALUES ('anthropic/claude-sonnet-4.5', 3.00, 0.30, 15.00, 0)
ON CONFLICT (model) DO NOTHING;
