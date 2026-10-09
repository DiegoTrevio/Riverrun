-- Cumplimiento: consentimiento explícito para promociones.
--  consent_at / consent_source: cuándo y cómo aceptó recibir promociones (NULL = no ha aceptado).
-- Los contactos que ya existían se marcan como 'legacy' para no cortar campañas en curso.
ALTER TABLE contacts
  ADD COLUMN consent_at     timestamptz,
  ADD COLUMN consent_source text NOT NULL DEFAULT '';
UPDATE contacts SET consent_at = created_at, consent_source = 'legacy' WHERE consent_at IS NULL;
