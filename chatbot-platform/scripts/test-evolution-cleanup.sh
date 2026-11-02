#!/usr/bin/env bash
# Prueba la limpieza de Evolution del contenedor de respaldos (INF-8) contra un PostgreSQL de verdad, con bases propias:
#  - borra los mensajes de los chats que el backend pidió borrar (por remoteJid o remoteJidAlt, solo en esa instancia),
#    marca la solicitud como hecha y le quita los identificadores;
#  - borra los mensajes más viejos que EVOLUTION_MESSAGE_DAYS y deja los recientes.
# Necesita un superusuario en PGHOST/PGUSER/PGPASSWORD (en CI lo da el servicio).
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=rr_cleanup_app EVO=rr_cleanup_evo
cleanup() { for db in "$APP" "$EVO"; do psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
cleanup
q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
q -d postgres -c "CREATE DATABASE $APP" >/dev/null
q -d postgres -c "CREATE DATABASE $EVO" >/dev/null
q -d "$APP" -f "$here/migrations/111_evolution_erasures.sql" >/dev/null
# Lo mínimo del esquema de Evolution (Prisma): instancias y mensajes con su llave JSON y su hora en segundos.
q -d "$EVO" >/dev/null <<'SQL'
CREATE TABLE "Instance" (id text PRIMARY KEY, name text);
CREATE TABLE "Message" (id text PRIMARY KEY, key jsonb, "messageTimestamp" int, "instanceId" text REFERENCES "Instance"(id) ON DELETE CASCADE);
INSERT INTO "Instance" VALUES ('i1', 'principal'), ('i2', 'otra');
INSERT INTO "Message" VALUES
  ('m1', '{"remoteJid":"5215511111111@s.whatsapp.net"}', extract(epoch FROM now())::int, 'i1'),
  ('m2', '{"remoteJid":"123@lid","remoteJidAlt":"5215511111111@s.whatsapp.net"}', extract(epoch FROM now())::int, 'i1'),
  ('m3', '{"remoteJid":"5215511111111@s.whatsapp.net"}', extract(epoch FROM now())::int, 'i2'),
  ('m4', '{"remoteJid":"5215522222222@s.whatsapp.net"}', extract(epoch FROM now())::int, 'i1'),
  ('m5', '{"remoteJid":"5215533333333@s.whatsapp.net"}', extract(epoch FROM now() - interval '10 days')::int, 'i1');
SQL
q -d "$APP" -c "INSERT INTO evolution_erasures (instance, jids) VALUES ('principal', ARRAY['123@lid','5215511111111@s.whatsapp.net'])" >/dev/null

BACKUP_APP_DB="$APP" BACKUP_EVOLUTION_DB="$EVO" EVOLUTION_MESSAGE_DAYS=7 BACKUP_DIR="$(mktemp -d)" bash "$here/docker/backup/backup.sh" evolution-cleanup

left="$(q -d "$EVO" -c "SELECT string_agg(id, ',' ORDER BY id) FROM \"Message\"")"
[[ "$left" == "m3,m4" ]] || { echo "ERROR: quedaron $left (se esperaba m3 de otra instancia y m4 de otro chat)"; exit 1; }
[[ "$(q -d "$APP" -c "SELECT done_at IS NOT NULL AND deleted = 2 AND jids = '{}' FROM evolution_erasures")" == t ]] || { echo "ERROR: la solicitud no quedó hecha y sin identificadores"; exit 1; }
# Otra vuelta no cambia nada.
BACKUP_APP_DB="$APP" BACKUP_EVOLUTION_DB="$EVO" BACKUP_DIR="$(mktemp -d)" bash "$here/docker/backup/backup.sh" evolution-cleanup
[[ "$(q -d "$EVO" -c "SELECT count(*) FROM \"Message\"")" == 2 ]]
echo "OK: la limpieza de Evolution borra lo pedido y lo viejo"
