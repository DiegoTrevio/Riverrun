#!/bin/sh
# Carga en Redis las claves de las sesiones de WhatsApp que dejó `backup.sh restore` en su volumen (riverrun-restore.rdb).
# Se ejecuta con el contenedor de Redis DETENIDO, dentro de su propia imagen (así la versión siempre entiende el archivo):
#
#   ./riverrun restore  →  docker compose run --rm --no-deps -T --entrypoint sh redis -s < docker/backup/redis-load.sh
#
# Con AOF activo (appendonly yes), Redis ignora un dump.rdb al arrancar y empezaría vacío. Por eso se carga sin AOF en un
# Redis temporal, se activa el AOF en caliente (Redis lo reescribe con todo lo cargado) y se apaga; al arrancar normal,
# lee ese AOF. Sin archivo que cargar no toca nada. Uso fuera de Docker (pruebas): redis-load.sh DIRECTORIO [PUERTO]
set -eu
DIR="${1:-/data}"
PORT="${2:-6399}"
SRC="$DIR/riverrun-restore.rdb"
[ -f "$SRC" ] || { echo "Sin claves de Redis que restaurar."; exit 0; }
head -c 5 "$SRC" | grep -q '^REDIS$' || { echo "riverrun-restore.rdb no es una copia de Redis"; exit 1; }

# Lo que haya ahora se reemplaza por el respaldo (igual que las bases de datos).
rm -rf "$DIR/appendonlydir" "$DIR/dump.rdb"
mv "$SRC" "$DIR/dump.rdb"
redis-server --dir "$DIR" --dbfilename dump.rdb --appendonly no --save '' --bind 127.0.0.1 --port "$PORT" \
  --daemonize yes --logfile "$DIR/riverrun-restore.log" --pidfile "$DIR/riverrun-restore.pid"
cli() { redis-cli -p "$PORT" "$@"; }
up=0
for _ in $(seq 1 100); do cli ping 2>/dev/null | grep -q PONG && { up=1; break; }; sleep 0.2; done
[ "$up" = 1 ] || { cat "$DIR/riverrun-restore.log" 2>/dev/null; echo "Redis no pudo cargar la copia"; exit 1; }
keys="$(cli info keyspace | grep -c '^db' || true)"
cli config set appendonly yes >/dev/null
done_=0
for _ in $(seq 1 600); do
  st="$(cli info persistence | tr -d '\r')"
  if echo "$st" | grep -q '^aof_enabled:1' && echo "$st" | grep -q '^aof_rewrite_in_progress:0' && echo "$st" | grep -q '^aof_rewrite_scheduled:0'; then done_=1; break; fi
  sleep 0.2
done
cli shutdown nosave >/dev/null 2>&1 || true
for _ in $(seq 1 50); do [ -f "$DIR/riverrun-restore.pid" ] || break; sleep 0.2; done
[ "$done_" = 1 ] && [ -f "$DIR/appendonlydir/appendonly.aof.manifest" ] || { cat "$DIR/riverrun-restore.log" 2>/dev/null; echo "Redis no terminó de escribir el AOF"; exit 1; }
rm -f "$DIR/riverrun-restore.log"
# La imagen oficial corre Redis con su propio usuario.
if id redis >/dev/null 2>&1; then chown -R redis:redis "$DIR" 2>/dev/null || true; fi
echo "Claves de las sesiones de WhatsApp restauradas en Redis (${keys} base(s))."
