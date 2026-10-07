-- Table names and counts only. Requires writers paused during backup for a comparable snapshot.
SELECT format('SELECT %L || ''|'' || count(*)::text FROM %I.%I;', table_name, table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name
\gexec
