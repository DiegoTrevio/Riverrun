-- migrate:no-transaction
-- Exportar contactos recorre la cuenta en orden de alta, por lotes (cursor por fecha e id): sin este índice ordenaba
-- todos los contactos de la cuenta en cada lote.
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_account_created_idx ON contacts (account_id, created_at, id);
