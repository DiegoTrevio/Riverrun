#!/usr/bin/env bash
# Suite de compatibilidad contra Evolution API REAL en un entorno aislado y desechable: el mismo docker-compose.yml de
# producción (solo postgres, redis y evolution), con otro nombre de proyecto, claves aleatorias, sin el .env de la
# instalación y con Evolution publicado solo en 127.0.0.1 en un puerto libre. Sin teléfonos ni datos reales.
#
#   scripts/evolution-compat.sh [imagen]       por defecto, la fijada en docker-compose.yml
#   EVOLUTION_FROM_IMAGE=evoapicloud/evolution-api:v2.3.6 scripts/evolution-compat.sh
#        además prueba la actualización desde esa versión: la instancia, su identificador y su webhook se conservan,
#        y se comprueba que las migraciones de esquema avanzan (por eso no hay vuelta atrás automática).
#   EVOLUTION_EXPECT_INCOMPATIBLE=1 scripts/evolution-compat.sh evoapicloud/evolution-api:2.4.0-rc2@sha256:…
#        comprueba que RiverRun detecta esa imagen como incompatible (p. ej. la 2.4 exige licencia).
#
# Al terminar borra el proyecto de prueba (contenedores, red y volúmenes de ESE proyecto, nunca los de la instalación).
set -Eeuo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."
compose_default() { sed -n 's/^x-evolution-image: &evolution-image \${EVOLUTION_IMAGE:-\(.*\)}$/\1/p' docker-compose.yml; }
TARGET="${1:-$(compose_default)}"
FROM="${EVOLUTION_FROM_IMAGE:-}"
PROJECT="rr-evocompat-$$"
work="$(mktemp -d)"
key="$(openssl rand -hex 24)"
log() { printf '\n== %s\n' "$*"; }
dcp() { docker compose -p "$PROJECT" --env-file "$work/env" -f docker-compose.yml -f "$work/override.yml" "$@"; }
cleanup() { dcp down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
unset COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_FILE

# Solo variables de prueba (nunca el .env de la instalación).
cat > "$work/env" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 12)
EVOLUTION_API_KEY=$key
BACKUP_PASSPHRASE=solo-para-validar-compose
SESSION_SECRET=solo-para-validar-compose
ADMIN_PASSWORD=solo-para-validar-compose
DOMAIN=localhost
EOF
cat > "$work/override.yml" <<'EOF'
services:
  evolution:
    ports: !override
      - "127.0.0.1::8080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
EOF

# Espera a que Evolution responda. El puerto publicado es efímero: cambia con cada arranque del contenedor.
wait_ready() {
  for _ in $(seq 1 90); do
    port="$(dcp port evolution 8080 2>/dev/null | head -n 1 | sed 's/.*://')"
    URL="http://127.0.0.1:$port"
    if [[ -n "$port" ]] && curl -fsS "$URL/" 2>/dev/null | grep -q '"version"'; then return 0; fi
    sleep 2
  done
  dcp logs --tail 60 evolution; echo "Evolution no respondió"; exit 1
}
# Descarga solo las imágenes que falten (Compose decide si están en local), con reintentos: Docker Hub limita las
# descargas anónimas (HTTP 429) y en CI se agotan con facilidad.
pull_images() {
  local n
  for n in 1 2 3 4 5; do
    dcp pull --policy missing >/dev/null 2>&1 && return 0
    (( n < 5 )) && { echo "Descarga de imágenes fallida (intento $n); se reintenta en $((n * 20)) s…"; sleep $((n * 20)); }
  done
  echo "No se pudieron descargar las imágenes (¿límite de descargas de Docker Hub?)"; exit 1
}
start_evolution() { # imagen
  echo "EVOLUTION_IMAGE=$1" >> "$work/env"
  pull_images
  dcp up -d postgres redis evolution >/dev/null
  wait_ready
}
migration() { dcp exec -T postgres psql -U chatbot -d evolution -Atc "SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"; }
expected_version() { curl -fsS "$URL/" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
run_tests() { # fase
  EVOLUTION_LIVE_URL="$URL" EVOLUTION_LIVE_KEY="$key" EVOLUTION_LIVE_PHASE="$1" EVOLUTION_LIVE_STATE="$work/state.json" \
    EVOLUTION_LIVE_EXPECT="${2:-}" node --import tsx --test test/evolution-live.test.ts 2>&1 | tee -a "$work/report" | grep -E '^(not )?ok|# (pass|fail|skip)|SKIP|skip' || true
  if grep -q '^not ok' "$work/report"; then grep -A30 '^not ok' "$work/report" | grep -vE '^\s+(duration_ms|type|location|failureType):'; dcp logs --tail 40 evolution; echo "Falló la fase $1"; exit 1; fi
}

log "Imagen a verificar: $TARGET"
if [[ "${EVOLUTION_EXPECT_INCOMPATIBLE:-}" == "1" ]]; then
  start_evolution "$TARGET"
  echo "Responde: $(curl -fsS "$URL/" | head -c 120)"
  run_tests incompatible
  echo "OK: RiverRun detecta $TARGET como incompatible."
  exit 0
fi
if [[ -n "$FROM" ]]; then
  log "Arranque con la versión de origen: $FROM"
  start_evolution "$FROM"
  from_version="$(expected_version)"; from_mig="$(migration)"
  echo "Versión $from_version · esquema $from_mig"
  run_tests persist-setup
  log "Actualización a $TARGET (mismos volúmenes y base: como ./riverrun update)"
  start_evolution "$TARGET"
  to_mig="$(migration)"
  echo "Versión $(expected_version) · esquema $to_mig"
  [[ "$to_mig" > "$from_mig" || "$to_mig" == "$from_mig" ]] || { echo "El esquema retrocedió"; exit 1; }
  [[ "$to_mig" != "$from_mig" ]] && echo "Aplicó migraciones ($from_mig → $to_mig): volver a $FROM ya no es seguro sin restaurar el respaldo."
  run_tests persist-check
else
  start_evolution "$TARGET"
  run_tests persist-setup
fi

log "Reinicio del contenedor: las sesiones y webhooks sobreviven"
dcp restart evolution >/dev/null
wait_ready
run_tests persist-check

log "Suite de compatibilidad"
run_tests suite "$(expected_version)"

log "Resumen (solo verificaciones reales; las de otra fase no cuentan)"
echo "  pasaron:  $(grep -E '^ok ' "$work/report" | grep -vc '# SKIP' || true)"
echo "  fallaron: $(grep -c '^not ok' "$work/report" || true)"
grep -E '^ok .* # SKIP' "$work/report" | grep -v '# SKIP fase' | sed 's/^ok [0-9]* - /  omitida: /' || true
echo "OK: $TARGET es compatible con RiverRun en todo lo verificable sin teléfono."
