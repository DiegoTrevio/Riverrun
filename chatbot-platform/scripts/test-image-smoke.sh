#!/usr/bin/env bash
# Prueba de humo de la imagen del backend: arranca con su base de datos, Docker la marca sana (HEALTHCHECK), responde
# con sus encabezados de seguridad y se apaga en orden (sale con 0). También valida el Caddyfile con Caddy de verdad.
# Usa su propio proyecto de compose (riverrun-humo): no toca una instalación existente. Requiere Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

export POSTGRES_PASSWORD="humo-postgres-0123456789abcdef"
export EVOLUTION_API_KEY="humo-evolution-0123456789abcdef"
export BACKUP_PASSPHRASE="humo-respaldo-0123456789abcdef"
export ADMIN_PASSWORD="humo-admin-0123456789abcdef"
export SESSION_SECRET="humo-sesion-0123456789abcdef0123456789abcdef"
export DOMAIN="ejemplo.com"
export PANEL_BIND=127.0.0.1
port=3000

dc() { docker compose -p riverrun-humo "$@"; }
fail() { echo "✕ $1"; dc logs --no-color backend 2>/dev/null | tail -60 || true; exit 1; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm -e DOMAIN="$DOMAIN" -v "$PWD/docker/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || fail "El Caddyfile no es válido"

dc up -d --no-deps --wait postgres
dc up -d --no-deps --build backend
id="$(dc ps -q backend)"
state=starting
for _ in $(seq 1 90); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)"
  [[ "$state" == healthy || "$state" == unhealthy ]] && break
  sleep 2
done
[[ "$state" == healthy ]] || fail "El backend no quedó sano (estado: $state)"

curl -fsS "http://127.0.0.1:$port/health/ready" >/dev/null || fail "/health/ready no respondió 200"
headers="$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$port/")"
grep -qi "^content-security-policy: default-src 'self'" <<<"$headers" || fail "El panel no trae su CSP"
grep -qi '^x-frame-options: DENY' <<<"$headers" || fail "El panel se puede incrustar en otro sitio"
grep -qi '^x-content-type-options: nosniff' <<<"$headers" || fail "Falta nosniff"

start=$(date +%s)
dc stop -t 60 backend >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$id")"
[[ "$code" == 0 ]] || fail "Al apagarse, el backend salió con $code (se esperaba 0)"
echo "✓ Imagen del backend: arranca sana, responde con sus encabezados y se apaga en orden ($(( $(date +%s) - start )) s)."
