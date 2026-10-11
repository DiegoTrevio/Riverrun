#!/usr/bin/env bash
# Prueba del simulacro de restauración sin S3 (la corre CI): crea dos bases con datos, las respalda con la imagen de
# respaldos de producción (docker/backup) y comprueba que restore-drill.sh abre y restaura ese respaldo. También
# comprueba que falla con una clave equivocada y con una lista de bases que no coincide con el respaldo. No toca nada
# fuera de sus propios contenedores y red, que borra al terminar.
#
#   DRILL_BACKUP_IMAGE=imagen bash scripts/test-restore-drill.sh   usa una imagen de respaldos ya construida
#   bash scripts/test-restore-drill.sh                             construye la de docker/backup
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_IMAGE="${DRILL_PG_IMAGE:-pgvector/pgvector:0.8.7-pg16}"
RUN="rr-test-drill-$$"
SRC="$RUN-src"
NET="$RUN-net"
PASS="clave-de-prueba-$$"
WORK="$(mktemp -d)"
BACKUP_IMAGE="${DRILL_BACKUP_IMAGE:-}"

fail() { echo "ERROR: $*" >&2; exit 1; }
cleanup() {
  docker rm -f "$SRC" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

if [[ -z "$BACKUP_IMAGE" ]]; then
  BACKUP_IMAGE="rr-test-drill-backup"
  docker build -q -t "$BACKUP_IMAGE" "$ROOT/docker/backup" >/dev/null
fi

docker network create "$NET" >/dev/null
docker run -d --name "$SRC" --network "$NET" \
  -e POSTGRES_USER=chatbot -e POSTGRES_PASSWORD=chatbot -e POSTGRES_DB=chatbot "$PG_IMAGE" >/dev/null
ready=false
for _ in $(seq 1 90); do
  if docker exec "$SRC" pg_isready -h 127.0.0.1 -U chatbot >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]] || fail "PostgreSQL de prueba no arrancó"

# Dos bases como en producción (chatbot y evolution), con datos que hay que encontrar al restaurar.
docker exec "$SRC" psql -v ON_ERROR_STOP=1 -U chatbot -d chatbot -c "CREATE TABLE prueba (id int, texto text); INSERT INTO prueba VALUES (1, 'hola');" >/dev/null
docker exec "$SRC" psql -v ON_ERROR_STOP=1 -U chatbot -d chatbot -c "CREATE DATABASE evolution OWNER chatbot;" >/dev/null
docker exec "$SRC" psql -v ON_ERROR_STOP=1 -U chatbot -d evolution -c "CREATE TABLE sesiones (id int); INSERT INTO sesiones VALUES (7);" >/dev/null

# Respaldo con la imagen de producción. Corre con nuestro UID para que los archivos sean borrables al terminar.
mkdir -p "$WORK/respaldos"
docker run --rm --user "$(id -u):$(id -g)" --network "$NET" -v "$WORK/respaldos:/backups" \
  -e BACKUP_DIR=/backups -e PGHOST="$SRC" -e PGUSER=chatbot -e PGPASSWORD=chatbot \
  -e BACKUP_PASSPHRASE="$PASS" -e BACKUP_DATABASES="chatbot evolution" \
  -e UPLOADS_DIR=/no-existe -e EVOLUTION_DIR=/no-existe \
  "$BACKUP_IMAGE" now >"$WORK/respaldo.log" 2>&1 || { cat "$WORK/respaldo.log"; fail "el respaldo de prueba no se creó"; }
FILE="$(find "$WORK/respaldos" -maxdepth 1 -name 'riverrun-*.tar.enc' -printf '%f\n' | head -n 1)"
[[ -n "$FILE" ]] || fail "no apareció el archivo del respaldo"
cp "$WORK/respaldos/$FILE" "$WORK/$FILE"
echo "Respaldo de prueba: $FILE"

drill() { DRILL_BACKUP_IMAGE="$BACKUP_IMAGE" bash "$ROOT/scripts/restore-drill.sh" "$@"; }

# 1. Con la clave correcta, el simulacro tiene que pasar y decir que verificó las dos bases.
out="$(BACKUP_PASSPHRASE="$PASS" BACKUP_DATABASES="chatbot evolution" drill "$WORK/$FILE" 2>&1)" \
  || { echo "$out"; fail "el simulacro falló con la clave correcta"; }
echo "$out" | grep -q "chatbot: [0-9]* tablas" || { echo "$out"; fail "no se verificó la base chatbot"; }
echo "$out" | grep -q "evolution: [0-9]* tablas" || { echo "$out"; fail "no se verificó la base evolution"; }
echo "OK: clave correcta, ambas bases restauradas"

# 2. Con una clave equivocada tiene que fallar.
if BACKUP_PASSPHRASE="otra-clave" BACKUP_DATABASES="chatbot evolution" drill "$WORK/$FILE" >"$WORK/clave.log" 2>&1; then
  fail "con una clave equivocada el simulacro no debió pasar"
fi
echo "OK: clave equivocada rechazada"

# 3. Si la lista de bases no coincide con el respaldo, tiene que fallar y decir qué falta.
if BACKUP_PASSPHRASE="$PASS" BACKUP_DATABASES="chatbot evolution inexistente" drill "$WORK/$FILE" >"$WORK/bases.log" 2>&1; then
  fail "con una base que no está en el respaldo el simulacro no debió pasar"
fi
grep -q "Falta la base inexistente" "$WORK/bases.log" || { cat "$WORK/bases.log"; fail "no se dijo qué base falta"; }
echo "OK: lista de bases que no coincide, rechazada"

# 4. Ningún contenedor ni red del simulacro debe quedar.
left="$(docker ps -a --format '{{.Names}}' | grep -c 'riverrun-drill-' || true)"
[[ "$left" == 0 ]] || fail "quedaron $left contenedores del simulacro"
echo "OK: sin restos"
echo "Prueba del simulacro de restauración: correcta"
