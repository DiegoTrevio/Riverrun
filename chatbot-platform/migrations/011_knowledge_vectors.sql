-- Optional on existing PostgreSQL installations. Rechecked at startup after an image upgrade.
DO $setup$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      model text NOT NULL,
      content_hash text NOT NULL,
      chunk_no integer NOT NULL CHECK (chunk_no >= 0),
      content text NOT NULL,
      embedding vector(1536) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, model, chunk_no)
    );
    -- Exact cosine search within the agent: avoids approximate-index filtering losses.
    CREATE INDEX IF NOT EXISTS knowledge_chunks_item_idx ON knowledge_chunks(item_id);
  END IF;
END
$setup$;
