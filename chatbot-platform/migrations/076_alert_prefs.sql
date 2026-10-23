-- Quién recibe qué: cada persona elige, por grupo de avisos, si le llegan en el panel, por WhatsApp y por correo.
-- {} = lo de siempre (todo en el panel; WhatsApp si tiene número y lo activó; correo solo lo urgente).
ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Escalamiento: una conversación asignada que sigue sin respuesta de una persona avisa a los administradores una sola vez.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- Agrupar avisos: la misma persona no recibe dos avisos del mismo tipo de la misma conversación en 10 minutos.
CREATE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (user_id, kind, link, created_at DESC);
