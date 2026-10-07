-- Saving knowledge never calls the provider. Changed sources become durable pending work.
CREATE OR REPLACE FUNCTION invalidate_knowledge_chunks() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF to_regclass('public.knowledge_chunks') IS NOT NULL AND
    (NEW.category, NEW.title, NEW.content, NEW.active, NEW.always_include, NEW.chatbot_id)
    IS DISTINCT FROM
    (OLD.category, OLD.title, OLD.content, OLD.active, OLD.always_include, OLD.chatbot_id) THEN
    DELETE FROM public.knowledge_chunks WHERE item_id=OLD.id;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER knowledge_chunks_invalidation AFTER UPDATE ON knowledge_items
FOR EACH ROW EXECUTE FUNCTION invalidate_knowledge_chunks();
