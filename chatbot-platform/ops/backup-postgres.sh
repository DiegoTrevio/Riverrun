#!/usr/bin/env bash
# Read-only backup of one explicitly selected database. Keep the result private.
set -euo pipefail
umask 077
if [[ $# != 3 ]]; then
  echo 'Uso: bash ops/backup-postgres.sh CONTENEDOR BASE DIRECTORIO_NUEVO' >&2
  exit 2
fi
container=$1
database=$2
destination=$3
[[ $database =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo 'Nombre de base inválido' >&2; exit 2; }
[[ ! -e $destination ]] || { echo 'El destino ya existe; usa un directorio nuevo' >&2; exit 2; }
mkdir -m 700 -p "$destination"
destination=$(cd "$destination" && pwd)
ops_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
success=false
trap 'if [[ $success != true ]]; then echo "Respaldo incompleto; no restaurar: $destination" >&2; fi' EXIT
# The server's own pg_dump prevents client/server major-version mismatches.
# POSTGRES_USER is a role name; never read or print the password.
docker exec "$container" sh -eu -c 'exec pg_dump -U "${POSTGRES_USER:-postgres}" -Fc --no-owner --no-acl "$1"' sh "$database" > "$destination/database.dump"
docker exec "$container" sh -eu -c 'exec pg_dumpall -U "${POSTGRES_USER:-postgres}" --globals-only' > "$destination/globals.sql"
docker exec "$container" sh -eu -c 'exec psql -U "${POSTGRES_USER:-postgres}" -d "$1" -Atc "SHOW server_version"' sh "$database" > "$destination/server-version.txt"
printf '%s\n' "$database" > "$destination/database-name.txt"
docker exec -i "$container" sh -eu -c 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1"' sh "$database" < "$ops_dir/postgres-inventory.sql" > "$destination/inventory.txt"
(
  cd "$destination"
  sha256sum database.dump globals.sql server-version.txt database-name.txt inventory.txt > SHA256SUMS
)
success=true
echo 'Respaldo terminado. Contiene datos y roles sensibles; no subirlo a Git ni al PR.'
