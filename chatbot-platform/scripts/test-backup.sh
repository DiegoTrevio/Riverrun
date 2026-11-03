#!/usr/bin/env bash
# Prueba de punta a punta del respaldo: crea datos, respalda, destruye, restaura y comprueba que todo volvió.
# Necesita PostgreSQL accesible con las variables PGHOST/PGUSER/PGPASSWORD (en CI lo da el servicio de la prueba).
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"; dropdb --if-exists bk_src >/dev/null 2>&1 || true; dropdb --if-exists bk_evo >/dev/null 2>&1 || true' EXIT
mkdir -p "$work/up" "$work/evo" "$work/out"

export BACKUP_DATABASES=bk_src BACKUP_DIR="$work/out" UPLOADS_DIR="$work/up" EVOLUTION_DIR="$work/evo" BACKUP_PASSPHRASE="clave-de-prueba"
dropdb --if-exists bk_src; createdb bk_src
psql -q -d bk_src -c "CREATE TABLE clientes(id int, nombre text); INSERT INTO clientes VALUES (1, 'Ana'), (2, 'Luis');"
echo "foto" > "$work/up/foto.jpg"; echo "sesion" > "$work/evo/sesion.json"

echo "== respaldo"
bash "$here/docker/backup/backup.sh" now
test -f "$work/out/status.json"
grep -q '"ok": true' "$work/out/status.json"
grep -q '"verified": true' "$work/out/status.json"
f="$(ls "$work/out"/riverrun-*.gpg.tar | tail -n 1)"
echo "== INF-11: cada parte va cifrada dentro del archivo (nada en claro salvo el manifiesto y las sumas)"
plain="$(tar -tf "$f" | grep -v -E '^\./$|\.gpg$|^\./manifest\.json$|^\./SHA256SUMS$' || true)"
[[ -z "$plain" ]] || { echo "ERROR: partes sin cifrar: $plain"; exit 1; }
! tar -xOf "$f" | grep -aq "Luis" || { echo "ERROR: los datos se leen sin la clave"; exit 1; }
[[ ! -e "$work/out/.work" ]] || { echo "ERROR: quedó el directorio de trabajo"; exit 1; }

echo "== el archivo no se puede leer sin la clave"
if BACKUP_PASSPHRASE=otra bash "$here/docker/backup/backup.sh" verify >/dev/null 2>&1; then echo "ERROR: abrió con clave incorrecta"; exit 1; fi

echo "== sin clave no respalda (no deja datos sin cifrar)"
if BACKUP_PASSPHRASE='' bash "$here/docker/backup/backup.sh" now >/dev/null 2>&1; then echo "ERROR: respaldó sin clave"; exit 1; fi

echo "== destruir y restaurar"
psql -q -d bk_src -c "DROP TABLE clientes"; rm -f "$work/up/foto.jpg"; echo basura > "$work/up/otra.txt"; rm -f "$work/evo/sesion.json"
bash "$here/docker/backup/backup.sh" restore latest
[[ "$(psql -At -d bk_src -c 'SELECT count(*) FROM clientes')" == "2" ]] || { echo "ERROR: datos no restaurados"; exit 1; }
[[ -f "$work/up/foto.jpg" && ! -f "$work/up/otra.txt" && -f "$work/evo/sesion.json" ]] || { echo "ERROR: archivos no restaurados"; exit 1; }

echo "== el manifiesto registra la versión de Evolution; la verificación completa restaura también su base"
dropdb --if-exists bk_evo; createdb bk_evo
psql -q -d bk_evo -c "CREATE TABLE _prisma_migrations(migration_name text, finished_at timestamptz, rolled_back_at timestamptz);
  INSERT INTO _prisma_migrations VALUES ('20250918182355_add_kafka_integration', now(), NULL), ('20251122003044_add_chat_instance_remotejid_unique', now(), NULL), ('29990101000000_fallida', NULL, NULL);
  CREATE TABLE \"Session\"(\"sessionId\" text, creds text); INSERT INTO \"Session\" VALUES ('inst-1', '{}');"
export BACKUP_DATABASES="bk_src bk_evo" BACKUP_EVOLUTION_DB=bk_evo EVOLUTION_IMAGE="evoapicloud/evolution-api:v2.3.7@sha256:abc"
BACKUP_VERIFY_ALL=true bash "$here/docker/backup/backup.sh" now 2> "$work/log"
grep -q "bk_evo: 2 tablas" "$work/log" || { cat "$work/log"; echo "ERROR: no restauró la base de Evolution al verificar"; exit 1; }
f="$(ls "$work/out"/riverrun-*.gpg.tar | tail -n 1)"
tar -xOf "$f" ./manifest.json > "$work/manifest.json"
grep -q '"evolution_image": "evoapicloud/evolution-api:v2.3.7@sha256:abc"' "$work/manifest.json" || { cat "$work/manifest.json"; echo "ERROR: falta la imagen de Evolution en el manifiesto"; exit 1; }
grep -q '"evolution_migration": "20251122003044_add_chat_instance_remotejid_unique"' "$work/manifest.json" || { cat "$work/manifest.json"; echo "ERROR: falta la migración de Evolution"; exit 1; }
echo "== restaurar con otra versión de Evolution configurada avisa (sin bloquear) y conserva las sesiones"
psql -q -d bk_evo -c 'DELETE FROM "Session"'
EVOLUTION_IMAGE="evoapicloud/evolution-api:v2.3.6" bash "$here/docker/backup/backup.sh" restore latest 2> "$work/log"
grep -q "ATENCIÓN: el respaldo es de Evolution evoapicloud/evolution-api:v2.3.7" "$work/log" || { cat "$work/log"; echo "ERROR: no avisó del cambio de versión"; exit 1; }
[[ "$(psql -At -d bk_evo -c 'SELECT count(*) FROM "Session"')" == "1" ]] || { echo "ERROR: no restauró las sesiones de Evolution"; exit 1; }
# La misma imagen escrita de otra forma (repo@digest) no es otra versión.
EVOLUTION_IMAGE="evoapicloud/evolution-api@sha256:abc" bash "$here/docker/backup/backup.sh" restore latest 2> "$work/log"
! grep -q "ATENCIÓN" "$work/log" || { cat "$work/log"; echo "ERROR: aviso falso con el mismo digest"; exit 1; }
dropdb --if-exists bk_evo
export BACKUP_DATABASES=bk_src

echo "== claves de las sesiones de WhatsApp (Redis): se respaldan y vuelven al restaurar aunque Redis use AOF"
if command -v redis-server >/dev/null 2>&1 && command -v redis-cli >/dev/null 2>&1; then
  rport=6391; rdir="$work/redis"; mkdir -p "$rdir"
  redis_up() { redis-server --port "$rport" --bind 127.0.0.1 --dir "$rdir" --appendonly yes --daemonize yes --pidfile "$work/redis.pid" --logfile "$work/redis.log"
    for _ in $(seq 1 50); do redis-cli -p "$rport" ping 2>/dev/null | grep -q PONG && return 0; sleep 0.2; done; echo "ERROR: Redis de prueba no arrancó"; exit 1; }
  redis_down() { redis-cli -p "$rport" shutdown nosave >/dev/null 2>&1 || true; for _ in $(seq 1 50); do [[ -f "$work/redis.pid" ]] || return 0; sleep 0.2; done; }
  redis_up
  redis-cli -p "$rport" -n 6 HSET evolution:instance:inst-1 pre-key-1 '{"keyPair":"x"}' creds-ignorado 1 >/dev/null
  export BACKUP_REDIS_URI="redis://127.0.0.1:$rport"
  bash "$here/docker/backup/backup.sh" now
  grep -q '"ok": true' "$work/out/status.json" || { cat "$work/out/status.json"; echo "ERROR: el respaldo con Redis no pasó"; exit 1; }
  f="$(ls "$work/out"/riverrun-*.gpg.tar | tail -n 1)"
  tar -tf "$f" | grep -q '^./redis.rdb.gpg$' || { echo "ERROR: el respaldo no trae redis.rdb (cifrado)"; exit 1; }
  # Servidor nuevo: Redis vacío. La restauración deja la copia y redis-load.sh la carga (con AOF, un dump.rdb suelto se ignora).
  redis_down; rm -rf "${rdir:?}"/*
  REDIS_DATA_DIR="$rdir" bash "$here/docker/backup/backup.sh" restore latest
  [[ -f "$rdir/riverrun-restore.rdb" ]] || { echo "ERROR: la restauración no dejó la copia de Redis"; exit 1; }
  sh "$here/docker/backup/redis-load.sh" "$rdir" 6392
  [[ ! -f "$rdir/riverrun-restore.rdb" && -f "$rdir/appendonlydir/appendonly.aof.manifest" ]] || { echo "ERROR: redis-load.sh no dejó el AOF listo"; exit 1; }
  redis_up
  [[ "$(redis-cli -p "$rport" -n 6 HGET evolution:instance:inst-1 pre-key-1)" == '{"keyPair":"x"}' ]] || { echo "ERROR: las claves de Redis no volvieron"; exit 1; }
  sh "$here/docker/backup/redis-load.sh" "$rdir" 6392 | grep -q "Sin claves de Redis que restaurar" || { echo "ERROR: sin copia, redis-load.sh debe no tocar nada"; exit 1; }
  # Redis caído al respaldar: el respaldo de las bases se crea igual, pero queda marcado como fallido (se avisa).
  redis_down
  if bash "$here/docker/backup/backup.sh" now 2> "$work/log"; then echo "ERROR: un respaldo sin las claves de Redis se dio por bueno"; exit 1; fi
  grep -q '"ok": false' "$work/out/status.json" && grep -q "no incluye las claves de las sesiones" "$work/log" || { cat "$work/log"; echo "ERROR: no avisó que faltaba Redis"; exit 1; }
  unset BACKUP_REDIS_URI
else
  echo "(sin redis-server en este equipo: se omite)"
fi

echo "== INF-11: una parte alterada (con sus sumas rehechas) no se abre: el cifrado verifica la integridad"
bash "$here/docker/backup/backup.sh" now >/dev/null 2>&1
f="$(ls "$work/out"/riverrun-*.gpg.tar | tail -n 1)"
t="$work/tamper"; mkdir -p "$t"; tar -C "$t" -xf "$f"
printf '\x00' | dd of="$t/bk_src.dump.gpg" bs=1 seek=200 conv=notrunc 2>/dev/null
( cd "$t" && sha256sum ./*.gpg ./manifest.json > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS )
tar -C "$t" -cf "$work/out/riverrun-29990101-000000.gpg.tar" .
if bash "$here/docker/backup/backup.sh" verify "$work/out/riverrun-29990101-000000.gpg.tar" >/dev/null 2>&1; then echo "ERROR: verificó una parte alterada"; exit 1; fi
psql -q -d bk_src -c "INSERT INTO clientes VALUES (3, 'Eva')"
if bash "$here/docker/backup/backup.sh" restore "$work/out/riverrun-29990101-000000.gpg.tar" >/dev/null 2>&1; then echo "ERROR: restauró un respaldo alterado"; exit 1; fi
[[ "$(psql -At -d bk_src -c 'SELECT count(*) FROM clientes')" == "3" ]] || { echo "ERROR: un respaldo alterado borró datos"; exit 1; }
rm -f "$work/out/riverrun-29990101-000000.gpg.tar"

echo "== INF-11: un respaldo armado con partes en claro (sin la clave) no se verifica ni se restaura"
fk="$work/forjado"; mkdir -p "$fk"
pg_dump --format=custom --dbname=bk_src --file="$fk/bk_src.dump"
( cd "$fk" && tar -czf uploads.tar.gz -T /dev/null && cp "$t/manifest.json" . && sha256sum ./* > SHA256SUMS )
tar -C "$fk" -cf "$work/out/riverrun-29990103-000000.gpg.tar" .
if bash "$here/docker/backup/backup.sh" verify "$work/out/riverrun-29990103-000000.gpg.tar" >/dev/null 2>&1; then echo "ERROR: verificó un respaldo con partes en claro"; exit 1; fi
if bash "$here/docker/backup/backup.sh" restore "$work/out/riverrun-29990103-000000.gpg.tar" >/dev/null 2>&1; then echo "ERROR: restauró un respaldo con partes en claro"; exit 1; fi
[[ "$(psql -At -d bk_src -c 'SELECT count(*) FROM clientes')" == "3" ]] || { echo "ERROR: un respaldo forjado cambió datos"; exit 1; }
rm -f "$work/out/riverrun-29990103-000000.gpg.tar"

echo "== los respaldos de antes (.tar.enc, openssl) se siguen restaurando"
l="$work/legacy"; mkdir -p "$l"; tar -C "$l" -xf "$f"
rm -f "$l/SHA256SUMS.gpg"
for g in "$l"/*.gpg; do gpg --batch --quiet --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" --decrypt --output "${g%.gpg}" "$g" 2>/dev/null; rm -f "$g"; done
( cd "$l" && sha256sum ./*.dump ./*.tar.gz ./manifest.json > SHA256SUMS )
tar -C "$l" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE > "$work/out/riverrun-29990102-000000.tar.enc"
bash "$here/docker/backup/backup.sh" verify "$work/out/riverrun-29990102-000000.tar.enc" 2>/dev/null || { echo "ERROR: no verificó un respaldo de antes"; exit 1; }
bash "$here/docker/backup/backup.sh" restore "$work/out/riverrun-29990102-000000.tar.enc" 2>/dev/null
[[ "$(psql -At -d bk_src -c 'SELECT count(*) FROM clientes')" == "2" ]] || { echo "ERROR: no restauró un respaldo de antes"; exit 1; }
rm -f "$work/out/riverrun-29990102-000000.tar.enc"

echo "== archivo dañado se detecta"
f="$(ls "$work/out"/riverrun-*.gpg.tar | tail -n 1)"; head -c 2000 "$f" > "$f.cut"; mv "$f.cut" "$f"
if bash "$here/docker/backup/backup.sh" verify "$f" >/dev/null 2>&1; then echo "ERROR: no detectó el daño"; exit 1; fi
echo "OK: respaldo, cifrado, verificación y restauración funcionan"
