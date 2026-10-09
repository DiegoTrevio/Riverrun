-- Quién y desde dónde tomó una persona la conversación de este contacto (teléfono, panel). Se muestra en la ficha del contacto.
ALTER TABLE contacts ADD COLUMN handoff_at timestamptz;
ALTER TABLE contacts ADD COLUMN handoff_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN handoff_via text NOT NULL DEFAULT '' CHECK (handoff_via IN ('', 'telefono', 'panel', 'regla', 'bot'));
CREATE INDEX IF NOT EXISTS contacts_handoff_by_idx ON contacts(handoff_by);
