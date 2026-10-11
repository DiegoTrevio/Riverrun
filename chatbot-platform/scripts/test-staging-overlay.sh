#!/usr/bin/env bash
# Comprueba el overlay de staging con la configuración que Docker Compose renderiza. No arranca nada.
# Usa un .env temporal con valores falsos: nunca lee ni modifica el .env real.
# Los valores peligrosos (PANEL_BIND=0.0.0.0, OUTBOUND_MODE=live) se fuerzan en el entorno para comprobar que el overlay
# los gana: un .env de producción copiado a staging no debe abrir el panel ni enviar mensajes reales.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

cat > "$work/env" <<'EOF'
POSTGRES_PASSWORD=prueba-postgres-0123
EVOLUTION_API_KEY=prueba-evolution-0123
SESSION_SECRET=prueba-sesion-0123456789abcdef0123456789abcdef
BACKUP_PASSPHRASE=prueba-respaldo-0123
ADMIN_PASSWORD=prueba-admin-0123
DOMAIN=staging.ejemplo.test
EOF

# Render: sin variables de la máquina que alteren el resultado, salvo las que el caso pide.
render() { # perfil? → JSON por stdout
  local profile=() ; [[ "${1:-}" == "--https" ]] && profile=(--profile https)
  env -u PANEL_BIND -u OUTBOUND_MODE -u COMPOSE_PROFILES -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME \
    PANEL_BIND="${CASO_PANEL_BIND:-}" OUTBOUND_MODE="${CASO_OUTBOUND_MODE:-}" \
    docker compose --env-file "$work/env" -f docker-compose.yml -f docker-compose.staging.yml "${profile[@]}" config --format json
}

fallos=0
ok()   { printf '✓ %s\n' "$*"; }
fail() { printf '✕ %s\n' "$*"; fallos=$((fallos + 1)); }

# Verifica un JSON renderizado con una función de node. Devuelve 0 si la comprobación pasa.
check() { # descripción, script de node (recibe el JSON en la variable "cfg"), JSON
  local desc="$1" script="$2" json="$3"
  if printf '%s' "$json" | node -e "
    const cfg = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const ok = (function () { $script })();
    process.exit(ok ? 0 : 1);
  "; then ok "$desc"; else fail "$desc"; fi
}

caso_base="$(CASO_PANEL_BIND='' CASO_OUTBOUND_MODE='' render)"
caso_hostil="$(CASO_PANEL_BIND='0.0.0.0' CASO_OUTBOUND_MODE='live' render)"
caso_https="$(CASO_PANEL_BIND='' CASO_OUTBOUND_MODE='' render --https)"

check "el proyecto se llama riverrun-staging (volúmenes separados de producción)" \
  "return cfg.name === 'riverrun-staging' && Object.values(cfg.volumes || {}).every(v => String(v.name || '').startsWith('riverrun-staging'));" \
  "$caso_base"

check "todo puerto publicado queda en 127.0.0.1 (ni con PANEL_BIND=0.0.0.0 en el entorno)" \
  "return Object.values(cfg.services).every(s => (s.ports || []).every(p => p.host_ip === '127.0.0.1'));" \
  "$caso_hostil"

check "el panel se publica en 127.0.0.1:3000" \
  "return (cfg.services.backend.ports || []).some(p => p.host_ip === '127.0.0.1' && String(p.published) === '3000');" \
  "$caso_base"

check "caddy no publica 80 ni 443 en staging" \
  "return !cfg.services.caddy || (cfg.services.caddy.ports || []).length === 0;" \
  "$caso_base"

check "caddy no arranca aunque se active el perfil https" \
  "return !cfg.services.caddy;" \
  "$caso_https"

check "OUTBOUND_MODE=sandbox gana sobre OUTBOUND_MODE=live del entorno" \
  "return cfg.services.backend.environment.OUTBOUND_MODE === 'sandbox';" \
  "$caso_hostil"

check "staging no se declara producción (RIVERRUN_ENV=test), o la validación lo rechazaría con sandbox" \
  "return cfg.services.backend.environment.RIVERRUN_ENV === 'test';" \
  "$caso_hostil"

check "staging limita la memoria del backend y de Evolution (comportamiento de un VPS de ~2 GB)" \
  "return cfg.services.backend.mem_limit > 0 && cfg.services.evolution.mem_limit > 0;" \
  "$caso_base"

check "sin alertas externas ni latido" \
  "const e = cfg.services.backend.environment; return e.ALERT_WEBHOOK_URL === '' && e.HEARTBEAT_URL === '';" \
  "$caso_base"

check "sin copia de respaldos a la nube" \
  "const e = cfg.services.backup.environment; return e.BACKUP_S3_BUCKET === '' && e.BACKUP_S3_KEY === '' && e.BACKUP_S3_SECRET === '';" \
  "$caso_base"

if (( fallos > 0 )); then
  printf '\n%d comprobación(es) fallaron. El overlay de staging no cumple lo que promete.\n' "$fallos"
  exit 1
fi
printf '\nEl overlay de staging cumple sus garantías (verificado con la configuración renderizada).\n'
