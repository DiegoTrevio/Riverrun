#!/usr/bin/env bash
# Simulacro de restauración: comprueba que un respaldo se abre con la clave y se restaura en un servidor que no es el
# de producción. No toca ningún servicio ni volumen de producción: levanta un PostgreSQL temporal, sin puertos
# publicados, y lo borra al terminar.
#
#   scripts/restore-drill.sh                   baja el respaldo más reciente de la copia remota (BACKUP_S3_*)
#   scripts/restore-drill.sh ARCHIVO.tar.enc   prueba un respaldo que ya tienes en esta máquina
#
# Usa la misma imagen de respaldos que producción (docker/backup) y su comando "verify" con todas las bases, así que
# la prueba es la misma que corre el servidor cada noche, pero contra una copia descargada. Requiere docker y
# BACKUP_PASSPHRASE; sin archivo, también rclone y BACKUP_S3_BUCKET. BACKUP_DATABASES debe ser el de producción (por
# defecto "chatbot evolution"). Sale con 0 solo si la restauración termina bien.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# La misma imagen de PostgreSQL que el compose de producción: el respaldo usa la extensión vector.
PG_IMAGE="${DRILL_PG_IMAGE:-pgvector/pgvector:0.8.7-pg16}"
BACKUP_IMAGE="${DRILL_BACKUP_IMAGE:-}"

say() { printf '== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -n "${BACKUP_PASSPHRASE:-}" ]] || die "Falta BACKUP_PASSPHRASE: sin ella el respaldo no se puede abrir."
command -v docker >/dev/null 2>&1 || die "Falta docker."

RUN="drill-$$"
PG="riverrun-$RUN-pg"
NET="riverrun-$RUN-net"
WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. El respaldo: el que se pasa como argumento, o el más reciente de la copia remota.
if [[ $# -ge 1 ]]; then
  [[ -f "$1" ]] || die "No existe el archivo $1"
  cp "$1" "$WORK/"
  FILE="$(basename "$1")"
else
  [[ -n "${BACKUP_S3_BUCKET:-}" ]] || die "Sin archivo: define BACKUP_S3_BUCKET (y sus claves) para bajar el último respaldo remoto."
  command -v rclone >/dev/null 2>&1 || die "Falta rclone (apt install rclone) para bajar el respaldo remoto."
  # Mismas variables que backup.sh para la copia en la nube.
  export RCLONE_CONFIG_BK_TYPE=s3 RCLONE_CONFIG_BK_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_BK_ACCESS_KEY_ID="${BACKUP_S3_KEY:-}" RCLONE_CONFIG_BK_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET:-}"
  export RCLONE_CONFIG_BK_ENDPOINT="${BACKUP_S3_ENDPOINT:-}" RCLONE_CONFIG_BK_REGION="${BACKUP_S3_REGION:-}"
  REMOTE="bk:${BACKUP_S3_BUCKET}/riverrun"
  say "Buscando el respaldo más reciente en la copia remota"
  FILE="$(rclone lsf "$REMOTE" --include 'riverrun-*.tar.enc' | sort | tail -n 1)"
  [[ -n "$FILE" ]] || die "No hay respaldos cifrados en la copia remota."
  say "Bajando $FILE"
  rclone copyto "$REMOTE/$FILE" "$WORK/$FILE"
fi
say "Respaldo: $FILE ($(du -h "$WORK/$FILE" | cut -f1))"

# 2. La imagen de respaldos: la misma que producción, construida desde docker/backup.
if [[ -z "$BACKUP_IMAGE" ]]; then
  BACKUP_IMAGE="riverrun-drill-backup"
  say "Construyendo la imagen de respaldos (docker/backup)"
  docker build -q -t "$BACKUP_IMAGE" "$ROOT/docker/backup" >/dev/null
fi

# 3. PostgreSQL temporal, en una red privada. Nada se publica fuera.
say "PostgreSQL temporal ($PG_IMAGE), sin puertos publicados"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=chatbot -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=chatbot \
  "$PG_IMAGE" >/dev/null
ready=false
for _ in $(seq 1 90); do
  if docker exec "$PG" pg_isready -h 127.0.0.1 -U chatbot >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]] || die "El PostgreSQL temporal no arrancó."

# 4. Abrir con la clave, comprobar sumas, restaurar cada base en una temporal y contar tablas. Es el "verify" de cada
#    noche; si algo falla, el comando sale con código distinto de 0 y el simulacro falla.
say "Restaurando todas las bases del respaldo y contando tablas"
docker run --rm --network "$NET" \
  -v "$WORK:/backups" \
  -e BACKUP_DIR=/backups \
  -e BACKUP_VERIFY_ALL=true \
  -e BACKUP_DATABASES="${BACKUP_DATABASES:-chatbot evolution}" \
  -e BACKUP_PASSPHRASE \
  -e PGHOST="$PG" -e PGUSER=chatbot -e PGPASSWORD=drill \
  "$BACKUP_IMAGE" verify "/backups/$FILE"

say "Simulacro correcto el $(date -u +%F): $FILE se abre con la clave y se restaura en un PostgreSQL temporal."
