-- Pendientes y notas por contacto: lo que falta por hacer con esa persona, o dónde se quedó la conversación.
CREATE TABLE IF NOT EXISTS contact_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  kind            text NOT NULL DEFAULT 'pendiente' CHECK (kind IN ('pendiente', 'nota')),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  status          text NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'hecha')),
  due_on          date,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_via     text NOT NULL DEFAULT 'panel' CHECK (created_via IN ('panel', 'regla')),
  done_at         timestamptz,
  done_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_tasks_contact_idx ON contact_tasks(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_tasks_account_idx ON contact_tasks(account_id);
CREATE INDEX IF NOT EXISTS contact_tasks_conversation_idx ON contact_tasks(conversation_id);
CREATE INDEX IF NOT EXISTS contact_tasks_created_by_idx ON contact_tasks(created_by);
CREATE INDEX IF NOT EXISTS contact_tasks_done_by_idx ON contact_tasks(done_by);
