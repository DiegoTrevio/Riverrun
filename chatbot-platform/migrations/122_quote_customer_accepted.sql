-- El cliente dice en el chat que acepta la cotización: queda anotado cuándo y con qué palabras, para que el equipo la
-- marque aceptada con su plan de cobro (la aceptación formal sigue siendo del equipo).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_accepted_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_accepted_text text NOT NULL DEFAULT '';
