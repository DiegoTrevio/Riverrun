-- De dónde se importó cada bloque de conocimiento (página web), para poder volver a sincronizarlo con un clic.
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS source_url text;
