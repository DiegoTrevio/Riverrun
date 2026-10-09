#!/usr/bin/env bash
# Prueba de punta a punta del respaldo: crea datos, respalda, destruye, restaura y comprueba que todo volvió.
# Necesita PostgreSQL accesible con las variables PGHOST/PGUSER/PGPASSWORD (en CI lo da el servicio de la prueba).
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"; dropdb --if-exists bk_src >/dev/null 2>&1 || true' EXIT
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
ls "$work/out"/riverrun-*.tar.enc >/dev/null

echo "== el archivo no se puede leer sin la clave"
if BACKUP_PASSPHRASE=otra bash "$here/docker/backup/backup.sh" verify >/dev/null 2>&1; then echo "ERROR: abrió con clave incorrecta"; exit 1; fi

echo "== sin clave no respalda (no deja datos sin cifrar)"
if BACKUP_PASSPHRASE='' bash "$here/docker/backup/backup.sh" now >/dev/null 2>&1; then echo "ERROR: respaldó sin clave"; exit 1; fi

echo "== destruir y restaurar"
psql -q -d bk_src -c "DROP TABLE clientes"; rm -f "$work/up/foto.jpg"; echo basura > "$work/up/otra.txt"; rm -f "$work/evo/sesion.json"
bash "$here/docker/backup/backup.sh" restore latest
[[ "$(psql -At -d bk_src -c 'SELECT count(*) FROM clientes')" == "2" ]] || { echo "ERROR: datos no restaurados"; exit 1; }
[[ -f "$work/up/foto.jpg" && ! -f "$work/up/otra.txt" && -f "$work/evo/sesion.json" ]] || { echo "ERROR: archivos no restaurados"; exit 1; }

echo "== archivo dañado se detecta"
f="$(ls "$work/out"/riverrun-*.tar.enc | tail -n 1)"; head -c 2000 "$f" > "$f.cut"; mv "$f.cut" "$f"
if bash "$here/docker/backup/backup.sh" verify "$f" >/dev/null 2>&1; then echo "ERROR: no detectó el daño"; exit 1; fi
echo "OK: respaldo, cifrado, verificación y restauración funcionan"
