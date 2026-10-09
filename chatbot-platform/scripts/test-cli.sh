#!/usr/bin/env bash
# Prueba el flujo de ./riverrun update con un "docker" simulado: respaldo previo, actualización buena,
# vuelta atrás cuando la versión nueva no queda sana, y negativa a actualizar sin respaldo o con cambios a mano.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export RIVERRUN_WAIT_SECONDS=2 RIVERRUN_POLL=1
LOG="$work/docker.log"; export LOG

# docker simulado: registra cada llamada; la salud falla si existe VERSION_MALA en el directorio actual; el respaldo falla si existe FALLA_RESPALDO.
mkdir -p "$work/bin"
cat > "$work/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo "docker $*" >> "$LOG"
case "$*" in
  "compose version") echo "Docker Compose version v2" ;;
  *"wget -qO-"*) [[ -f VERSION_MALA ]] && exit 1; echo '{"ok":true}' ;;
  *"backup.sh now"*) [[ -f FALLA_RESPALDO ]] && exit 1; exit 0 ;;
  *"images -q backend"*) echo "sha256:abc123" ;;
  *"config --images"*) echo "plataforma-backend"; cat PG_IMAGE 2>/dev/null || echo "postgres:16-alpine" ;;
esac
exit 0
SHIM
chmod +x "$work/bin/docker"; export PATH="$work/bin:$PATH"

git init -q --bare "$work/origin.git"
git clone -q "$work/origin.git" "$work/app" 2>/dev/null
cd "$work/app"
cp "$here/riverrun" . && echo "v1" > VERSION && git add -A && git commit -qm "v1" && git push -q origin HEAD:main 2>/dev/null
git branch -q --set-upstream-to=origin/main 2>/dev/null || git branch -q -u origin/main
# Publica una versión nueva en el "origin" y deja la copia local donde estaba.
newcommit() {
  local base; base="$(git rev-parse HEAD)"
  git fetch -q origin; git reset -q --hard origin/main
  git rm -q -f --ignore-unmatch VERSION_MALA
  echo "$1" > VERSION
  if [[ -n "${2:-}" ]]; then touch "$2"; fi
  git add -A; git commit -qm "$1"; git push -q origin HEAD:main
  git reset -q --hard "$base"
}
: > "$LOG"

echo "== sin cambios nuevos"
./riverrun update | grep -q "última versión"

echo "== actualización buena: respaldo primero, luego construir"
newcommit v2
./riverrun update >/dev/null
[[ "$(cat VERSION)" == v2 ]]
grep -n "backup.sh now\|up -d --build" "$LOG" | head -2 | cut -d: -f2- | head -1 | grep -q "backup.sh now"
grep -q "up -d --build" "$LOG"

echo "== versión nueva enferma: vuelve a la anterior"
: > "$LOG"
newcommit v3-mala VERSION_MALA
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: debió fallar"; exit 1; fi
[[ "$(cat VERSION)" == v2 && ! -f VERSION_MALA ]] || { echo "ERROR: no volvió al código anterior"; exit 1; }
grep -q "docker tag sha256:abc123 riverrun-backend:previous" "$LOG"
grep -q "docker tag riverrun-backend:previous plataforma-backend" "$LOG"
grep -q "up -d --no-build backend" "$LOG"

echo "== sin respaldo no se actualiza"
: > "$LOG"; newcommit v4
touch FALLA_RESPALDO
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: actualizó sin respaldo"; exit 1; fi
[[ "$(cat VERSION)" == v2 ]]
! grep -q "up -d --build" "$LOG"
rm -f FALLA_RESPALDO

echo "== una versión que cambia la imagen de PostgreSQL no se aplica sola"
: > "$LOG"
git rm -q -f --ignore-unmatch FALLA_RESPALDO 2>/dev/null || true
base="$(git rev-parse HEAD)"; git fetch -q origin; git reset -q --hard origin/main
echo "pgvector/pgvector:0.8.7-pg16" > PG_IMAGE; echo v5 > VERSION; git add -A; git commit -qm v5; git push -q origin HEAD:main; git reset -q --hard "$base"
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: aplicó el cambio de imagen de base de datos"; exit 1; fi
[[ "$(cat VERSION)" != v5 ]] || { echo "ERROR: no revirtió el código"; exit 1; }
! grep -q "up -d --build" "$LOG"
./riverrun update --accept-db-image-change >/dev/null
[[ "$(cat VERSION)" == v5 ]]

echo "== con cambios hechos a mano se niega"
echo "cambio" >> VERSION
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: actualizó con cambios locales"; exit 1; fi
git checkout -q VERSION
echo "OK: el flujo de actualización funciona"
