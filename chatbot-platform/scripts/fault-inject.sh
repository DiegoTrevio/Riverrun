#!/usr/bin/env bash
# Fallos inyectados sobre el stack de staging real (Docker). Solo para CI o un servidor de pruebas: usa el overlay de
# staging y genera su propio .env con valores falsos. Nunca lee el .env real.
#
# Por cada fallo: se inyecta, se espera a que el monitor lo confirme (dos ciclos de un minuto) y se comprueba el estado
# en /health/functional, la incidencia en la base y el aviso en el registro del backend. Después se recupera y se
# comprueba que todo vuelve a operativo y la incidencia se cierra.
#
# Limitación conocida: mientras PostgreSQL está caído no se puede escribir en la base; por eso el aviso de ese fallo se
# comprueba en el registro del backend, no en el historial de incidencias.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
work="$(mktemp -d)"
COMPOSE=(docker compose --env-file "$work/env" -f docker-compose.yml -f docker-compose.staging.yml)
TOKEN="$(openssl rand -hex 24)"
PORT_BASE="http://127.0.0.1:3000"
fallos=0
ok()   { printf '✓ %s\n' "$*"; }
fail() { printf '✕ %s\n' "$*"; fallos=$((fallos + 1)); }
cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

cat > "$work/env" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
EVOLUTION_API_KEY=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -hex 32)
BACKUP_PASSPHRASE=$(openssl rand -hex 16)
ADMIN_PASSWORD=$(openssl rand -hex 12)
DOMAIN=staging.ejemplo.test
HEALTH_TOKEN=$TOKEN
EOF

# Seguridad: el overlay debe dejar el entorno en sandbox antes de inyectar nada.
if ! "${COMPOSE[@]}" config --format json | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8')); process.exit(c.services.backend.environment.OUTBOUND_MODE === 'sandbox' ? 0 : 1)"; then
  echo "Abortado: la configuración renderizada no está en sandbox." >&2
  exit 1
fi

# Estado de un componente según /health/functional, o "sin_respuesta".
estado() {
  curl -fsS -H "Authorization: Bearer $TOKEN" "$PORT_BASE/health/functional" 2>/dev/null \
    | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8')); const c=j.components.find(x=>x.id===process.argv[1]); process.stdout.write(c?c.state:'ausente')" "$1" 2>/dev/null \
    || echo "sin_respuesta"
}
# Incidencias abiertas de un componente (cuenta lo que hay en la base).
abiertas() {
  "${COMPOSE[@]}" exec -T postgres psql -U chatbot -d chatbot -tAc "SELECT count(*) FROM incidents WHERE component = '$1' AND state = 'abierto'" 2>/dev/null | tr -d '[:space:]' || echo "?"
}
# Aviso emitido por el monitor, visto en el registro del backend (funciona aunque la base esté caída).
aviso_en_registro() {
  # Se captura antes de buscar: con pipefail, grep -q cerraría la tubería antes de que logs termine.
  local registro
  registro="$("${COMPOSE[@]}" logs --no-color backend 2>/dev/null || true)"
  grep -q "Alerta: $1" <<<"$registro" && echo si || echo no
}
# Espera a que el monitor complete n ciclos (cada minuto) más un margen para la caché de 15 s.
espera_ciclos() { sleep $(( $1 * 60 + 30 )); }

echo "== Arranque del stack de staging"
"${COMPOSE[@]}" up -d --wait postgres redis evolution backend
for _ in $(seq 1 40); do curl -fsS "$PORT_BASE/health" >/dev/null 2>&1 && break; sleep 5; done
curl -fsS "$PORT_BASE/health" >/dev/null || { fail "el backend no arrancó"; exit 1; }
"${COMPOSE[@]}" exec -T postgres psql -U chatbot -d chatbot -qc "
  INSERT INTO accounts (name) VALUES ('Fallos');
  INSERT INTO channels (account_id, type, name, webhook_token, active, config)
  VALUES ((SELECT id FROM accounts WHERE name = 'Fallos'), 'whatsapp', 'Canal de fallos', 'token-fallos', true, '{\"instance\":\"fallos\"}');"
# Margen de arranque del monitor (3 minutos): antes, "no responde" de Evolution es atención, no fallo.
espera_ciclos 4

echo "== Sin fallos: sin incidencias (falsos positivos)"
[[ "$(abiertas whatsapp)" == 0 && "$(abiertas database)" == 0 ]] && ok "ninguna incidencia abierta con el sistema sano" || fail "hay incidencias abiertas sin fallo inyectado"
[[ "$(estado whatsapp)" != no_disponible ]] && ok "WhatsApp no aparece como no disponible" || fail "WhatsApp aparece como no disponible sin fallo"

echo "== Evolution caído"
"${COMPOSE[@]}" stop evolution >/dev/null
espera_ciclos 3
[[ "$(estado whatsapp)" == no_disponible ]] && ok "el estado de WhatsApp es no disponible" || fail "WhatsApp no se midió como no disponible"
[[ "$(abiertas whatsapp)" == 1 ]] && ok "una incidencia abierta de WhatsApp" || fail "incidencias de WhatsApp: $(abiertas whatsapp), se esperaba 1"
[[ "$(aviso_en_registro 'Servicio de WhatsApp')" == si ]] && ok "el aviso se emitió" || fail "no hay aviso de WhatsApp en el registro"
"${COMPOSE[@]}" start evolution >/dev/null
espera_ciclos 4
[[ "$(estado whatsapp)" != no_disponible ]] && ok "al volver Evolution, WhatsApp deja de estar no disponible" || fail "WhatsApp sigue no disponible tras recuperar Evolution"
[[ "$(abiertas whatsapp)" == 0 ]] && ok "la incidencia de WhatsApp se cerró" || fail "la incidencia de WhatsApp sigue abierta"

echo "== PostgreSQL caído"
"${COMPOSE[@]}" stop postgres >/dev/null
espera_ciclos 3
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$PORT_BASE/health/ready")" == 503 ]] && ok "la preparación responde 503" || fail "la preparación no responde 503"
[[ "$(aviso_en_registro 'Base de datos')" == si ]] && ok "el aviso de base de datos se emitió aunque la base esté caída" || fail "no hay aviso de base de datos en el registro"
"${COMPOSE[@]}" start postgres >/dev/null
espera_ciclos 3
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$PORT_BASE/health/ready")" == 200 ]] && ok "la preparación vuelve a 200" || fail "la preparación no volvió a 200"
[[ "$(estado database)" == operativo ]] && ok "la base de datos vuelve a operativo" || fail "la base de datos no volvió a operativo"

echo "== Configuración crítica: el backend no debe arrancar"
if out="$("${COMPOSE[@]}" run --rm --no-deps -T -e OUTBOUND_MODE=modo-raro backend 2>&1)"; then
  fail "arrancó con OUTBOUND_MODE inválido"
elif grep -q "OUTBOUND_MODE" <<<"$out"; then
  ok "el arranque se niega y nombra la variable"
else
  fail "se negó a arrancar pero sin decir por qué"
fi

if (( fallos > 0 )); then
  printf '\n%d comprobación(es) fallaron.\n' "$fallos"
  exit 1
fi
printf '\nTodos los fallos se detectaron y se recuperaron como se esperaba.\n'
