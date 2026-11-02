-- Un usuario de PostgreSQL por servicio (INF-2). Lo corre ./riverrun (install, update, restore y db-roles) como el
-- superusuario `chatbot`, con psql y ON_ERROR_STOP; se puede repetir sin cambiar nada más que las contraseñas.
--
--   riverrun_app        dueño de la base `chatbot` y de todo lo suyo (el backend: corre las migraciones).
--   riverrun_evolution  dueño de la base `evolution` y de todo lo suyo (Evolution API: corre las suyas con Prisma).
--
-- Ninguno es superusuario ni puede crear bases o roles, y cada uno solo puede conectarse a su base: un fallo en
-- Evolution ya no lee las conversaciones del backend, y un fallo en el backend no puede ejecutar programas en el
-- servidor de la base (COPY … PROGRAM) ni leer la de Evolution. El superusuario se queda para el respaldo (verifica
-- cada copia restaurándola) y para restaurar.
--
-- Variables (psql): app_pw, evo_pw; app_db y evo_db (las bases; por omisión chatbot y evolution).

\set ON_ERROR_STOP on
\if :{?app_db} \else \set app_db chatbot \endif
\if :{?evo_db} \else \set evo_db evolution \endif

BEGIN;
SELECT 'CREATE ROLE riverrun_app LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'riverrun_app') \gexec
SELECT 'CREATE ROLE riverrun_evolution LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'riverrun_evolution') \gexec
ALTER ROLE riverrun_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_pw';
ALTER ROLE riverrun_evolution LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'evo_pw';
COMMIT;
SELECT format('CREATE DATABASE %I', :'evo_db') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'evo_db') \gexec

-- Cada base, solo para su dueño (y el superusuario). Antes cualquier rol podía conectarse a cualquiera.
REVOKE CONNECT, TEMPORARY ON DATABASE :"app_db" FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE :"evo_db" FROM PUBLIC;
ALTER DATABASE :"app_db" OWNER TO riverrun_app;
ALTER DATABASE :"evo_db" OWNER TO riverrun_evolution;
GRANT CONNECT, TEMPORARY ON DATABASE :"app_db" TO riverrun_app;
GRANT CONNECT, TEMPORARY ON DATABASE :"evo_db" TO riverrun_evolution;

-- Pasa al dueño nuevo todo lo de `public` que no es de una extensión: el esquema, tablas, secuencias sueltas, vistas,
-- funciones, tipos y dominios. (REASSIGN OWNED no sirve: `chatbot` es el superusuario con el que nació el servidor.)
-- Las secuencias de una columna (serial, identity) y los tipos de cada tabla cambian con su tabla.
\set transfer 'DO $transfer$ DECLARE r record; target text := current_setting(''riverrun.owner''); BEGIN EXECUTE format(''ALTER SCHEMA public OWNER TO %I'', target); FOR r IN SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ''public'' AND c.relkind IN (''r'',''p'',''v'',''m'',''S'',''f'') AND pg_get_userbyid(c.relowner) <> target AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = ''pg_class''::regclass AND d.objid = c.oid AND d.deptype IN (''e'',''a'',''i'')) LOOP EXECUTE format(''ALTER %s %s OWNER TO %I'', CASE r.relkind WHEN ''v'' THEN ''VIEW'' WHEN ''m'' THEN ''MATERIALIZED VIEW'' WHEN ''S'' THEN ''SEQUENCE'' WHEN ''f'' THEN ''FOREIGN TABLE'' ELSE ''TABLE'' END, r.obj, target); END LOOP; FOR r IN SELECT p.oid::regprocedure AS obj FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ''public'' AND pg_get_userbyid(p.proowner) <> target AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = ''pg_proc''::regclass AND d.objid = p.oid AND d.deptype = ''e'') LOOP EXECUTE format(''ALTER ROUTINE %s OWNER TO %I'', r.obj, target); END LOOP; FOR r IN SELECT t.oid::regtype AS obj, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ''public'' AND t.typtype IN (''e'',''d'',''r'',''m'',''c'') AND (t.typtype <> ''c'' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = ''c'') AND pg_get_userbyid(t.typowner) <> target AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = ''pg_type''::regclass AND d.objid = t.oid AND d.deptype = ''e'') LOOP EXECUTE format(''ALTER %s %s OWNER TO %I'', CASE r.typtype WHEN ''d'' THEN ''DOMAIN'' ELSE ''TYPE'' END, r.obj, target); END LOOP; END $transfer$;'

\connect :app_db
BEGIN;
-- Las extensiones las crea el superusuario: el backend ya no puede (pgvector no es «trusted»). Las migraciones las
-- piden con IF NOT EXISTS, que no exige permisos cuando ya están.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SET LOCAL riverrun.owner = 'riverrun_app';
:transfer
COMMIT;

\connect :evo_db
BEGIN;
SET LOCAL riverrun.owner = 'riverrun_evolution';
:transfer
COMMIT;
