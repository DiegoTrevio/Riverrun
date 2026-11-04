-- Copiloto: una acción que tarda (diseñar un flujo, importar información, correr pruebas) ya no pasa a «no sabemos si
-- se aplicó» a los 2 minutos mientras sigue corriendo. Quien la ejecuta renueva `lease_until` cada 30 s; la limpieza
-- solo la marca como desconocida cuando ese plazo vence (el proceso se cayó o se reinició a la mitad).
ALTER TABLE copilot_actions ADD COLUMN lease_until timestamptz;

-- Renovar el plazo no es una novedad para el panel: no mueve `rev` (si no, el panel vería la tarjeta cambiar cada 30 s).
CREATE FUNCTION copilot_action_rev() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.lease_until IS DISTINCT FROM OLD.lease_until
     AND (to_jsonb(NEW) - 'lease_until' - 'rev') = (to_jsonb(OLD) - 'lease_until' - 'rev') THEN
    RETURN NEW;
  END IF;
  NEW.rev := nextval('copilot_rev');
  RETURN NEW;
END $$;

DROP TRIGGER copilot_actions_rev ON copilot_actions;
CREATE TRIGGER copilot_actions_rev BEFORE INSERT OR UPDATE ON copilot_actions FOR EACH ROW EXECUTE FUNCTION copilot_action_rev();
