#!/usr/bin/env bash
# Restore exclusively into a NEW isolated container. Never accepts a target database/server.
set -euo pipefail
umask 077
if [[ $# != 1 ]]; then
  echo 'Uso: bash ops/verify-postgres-backup.sh DIRECTORIO_RESPALDO' >&2
  exit 2
fi
backup=$(cd "$1" && pwd)
ops_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! (cd "$backup" && sha256sum --check --status SHA256SUMS); then
  echo 'Integridad del respaldo inválida: revisa los archivos y checksums antes de restaurar.' >&2
  exit 1
fi
version=$(cat "$backup/server-version.txt")
[[ $version == 16.* ]] || { echo 'Este verificador requiere un respaldo PostgreSQL 16' >&2; exit 2; }
work=$(mktemp -d)
container="riverrun-restore-check-$(basename "$work" | tr -cd 'a-zA-Z0-9')"
cleanup() {
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
# No host ports, network or mounted production volumes. Trust auth exists only inside this container.
docker run -d --name "$container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:0.8.7-pg16 >/dev/null
for attempt in {1..60}; do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null
docker exec "$container" createdb -U postgres restore_check
# Globals are preserved for operator-led disaster recovery; never execute them in a verification.
docker exec -i "$container" pg_restore -U postgres -d restore_check --exit-on-error --no-owner --no-acl < "$backup/database.dump"
docker exec -i "$container" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d restore_check < "$ops_dir/postgres-inventory.sql" > "$work/inventory.txt"
if ! cmp -s "$backup/inventory.txt" "$work/inventory.txt"; then
  echo 'Los conteos no coinciden. Revisa el respaldo y repítelo con las escrituras pausadas.' >&2
  exit 1
fi
docker exec "$container" psql -U postgres -d restore_check -v ON_ERROR_STOP=1 -Atc \
  "SELECT 'tablas=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'; SELECT 'restricciones_sin_validar=' || count(*) FROM pg_constraint WHERE NOT convalidated;"
echo 'Restauración aislada terminada. No se inició el backend ni Evolution; no se enviaron mensajes.'
