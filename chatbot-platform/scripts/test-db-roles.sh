#!/usr/bin/env bash
# Prueba docker/db-roles.sql (INF-2) contra un PostgreSQL de verdad, con bases propias de la prueba:
#  - una base migrada por el superusuario (como las instalaciones de hoy) pasa entera al rol de la app;
#  - el rol de la app no es superusuario, solo entra a su base, migra, crea y cambia tablas, y no ejecuta programas;
#  - el rol de Evolution solo entra a la suya; el script se puede repetir;
#  - una base nueva se migra de cero con el rol de la app (las extensiones las deja creadas el superusuario).
# Necesita PostgreSQL 16 con pgvector y un superusuario en PGHOST/PGUSER/PGPASSWORD (en CI lo da el servicio).
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
APP_DB=rr_roles_app EVO_DB=rr_roles_evo NEW_DB=rr_roles_new
APP_PW="app-$(openssl rand -hex 8)" EVO_PW="evo-$(openssl rand -hex 8)"
host="${PGHOST:-localhost}" port="${PGPORT:-5432}"
cleanup() {
  for db in "$APP_DB" "$EVO_DB" "$NEW_DB"; do psql -q -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
cleanup
q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
roles() { # base de la app → corre el script como superusuario
  printf '\\set app_pw %s\n\\set evo_pw %s\n\\set app_db %s\n\\set evo_db %s\n' "'$APP_PW'" "'$EVO_PW'" "$1" "$EVO_DB" | cat - docker/db-roles.sql | psql -X -q -d postgres >/dev/null
}
as_app() { PGUSER=riverrun_app PGPASSWORD="$APP_PW" "$@"; }
as_evo() { PGUSER=riverrun_evolution PGPASSWORD="$EVO_PW" "$@"; }
migrate() { DATABASE_URL="$1" node --import tsx -e "const { migrate, pool } = await import('./src/db.ts'); await migrate(); await pool.end();"; }

echo "== una instalación de hoy: todo migrado por el superusuario"
q -d postgres -c "CREATE DATABASE $APP_DB" >/dev/null
q -d postgres -c "CREATE DATABASE $EVO_DB" >/dev/null
migrate "postgres://${PGUSER}:${PGPASSWORD}@${host}:${port}/${APP_DB}" >/dev/null
# Lo que deja Prisma en la base de Evolution: tablas, un enum, una secuencia de una columna.
q -d "$EVO_DB" -c "CREATE TYPE \"InstanceStatus\" AS ENUM ('open','close'); CREATE TABLE \"Instance\" (id serial PRIMARY KEY, name text, status \"InstanceStatus\"); CREATE TABLE _prisma_migrations (migration_name text, finished_at timestamptz, rolled_back_at timestamptz); INSERT INTO \"Instance\" (name, status) VALUES ('principal', 'open')" >/dev/null

roles "$APP_DB"
roles "$APP_DB" # se puede repetir

echo "== todo lo de la app es de riverrun_app (menos lo de las extensiones)"
left="$(q -d "$APP_DB" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'riverrun_app' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')")"
[[ "$left" == 0 ]] || { q -d "$APP_DB" -c "SELECT c.relname, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_get_userbyid(c.relowner) <> 'riverrun_app' LIMIT 20"; echo "ERROR: quedaron $left objetos de otro dueño"; exit 1; }
[[ "$(q -d "$APP_DB" -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")" == riverrun_app ]] || { echo "ERROR: la base no es de riverrun_app"; exit 1; }
[[ "$(q -d "$EVO_DB" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'riverrun_evolution'")" == 0 ]] || { echo "ERROR: en Evolution quedaron objetos de otro dueño"; exit 1; }
[[ "$(q -d postgres -c "SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole) FROM pg_roles WHERE rolname IN ('riverrun_app','riverrun_evolution')")" == f ]] || { echo "ERROR: un rol tiene privilegios de más"; exit 1; }

echo "== la app migra, crea y cambia tablas, pero no ejecuta programas ni entra a la base de Evolution"
as_app migrate "postgres://riverrun_app:${APP_PW}@${host}:${port}/${APP_DB}" >/dev/null
as_app q -d "$APP_DB" -c "CREATE TABLE prueba_roles (id int); ALTER TABLE accounts ADD COLUMN prueba_roles int; ALTER TABLE accounts DROP COLUMN prueba_roles; DROP TABLE prueba_roles" >/dev/null
if as_app q -d "$APP_DB" -c "COPY (SELECT 1) TO PROGRAM 'id'" >/dev/null 2>&1; then echo "ERROR: la app pudo ejecutar un programa"; exit 1; fi
if as_app q -d "$EVO_DB" -c "SELECT 1" >/dev/null 2>&1; then echo "ERROR: la app entró a la base de Evolution"; exit 1; fi
if as_app q -d postgres -c "CREATE DATABASE rr_roles_intruso" >/dev/null 2>&1; then echo "ERROR: la app pudo crear una base"; exit 1; fi

echo "== Evolution usa su base y no entra a la de la app"
[[ "$(as_evo q -d "$EVO_DB" -c "INSERT INTO \"Instance\" (name, status) VALUES ('segunda', 'close'); SELECT count(*) FROM \"Instance\"")" == 2 ]] || { echo "ERROR: Evolution no pudo usar su base"; exit 1; }
as_evo q -d "$EVO_DB" -c "ALTER TABLE \"Instance\" ADD COLUMN extra text; ALTER TYPE \"InstanceStatus\" ADD VALUE 'connecting'" >/dev/null
if as_evo q -d "$APP_DB" -c "SELECT 1" >/dev/null 2>&1; then echo "ERROR: Evolution entró a la base de la app"; exit 1; fi

echo "== instalación nueva: la app migra de cero (el superusuario dejó las extensiones)"
q -d postgres -c "CREATE DATABASE $NEW_DB" >/dev/null
roles "$NEW_DB"
as_app migrate "postgres://riverrun_app:${APP_PW}@${host}:${port}/${NEW_DB}" >/dev/null
[[ "$(as_app q -d "$NEW_DB" -c "SELECT count(*) FROM schema_migrations")" -gt 100 ]] || { echo "ERROR: no migró de cero"; exit 1; }

echo "OK: cada servicio con su usuario de PostgreSQL"
