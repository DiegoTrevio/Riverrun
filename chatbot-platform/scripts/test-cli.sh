#!/usr/bin/env bash
# Prueba el flujo de ./riverrun update con un "docker" simulado: respaldo previo, actualización buena,
# vuelta atrás cuando la versión nueva no queda sana, y negativa a actualizar sin respaldo o con cambios a mano.
# También el cambio de versión de Evolution API: compatibilidad, confirmación, respaldo verificado, verificación de
# sesiones, vuelta atrás solo cuando el esquema no cambió y nunca operaciones que borren sesiones.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export RIVERRUN_WAIT_SECONDS=2 RIVERRUN_POLL=1
LOG="$work/docker.log"; export LOG

# docker simulado: registra cada llamada; la salud falla si existe VERSION_MALA en el directorio actual; el respaldo falla si existe FALLA_RESPALDO.
# Evolution: EVO_RUNNING = imagen que corre; destino = EVOLUTION_IMAGE de .env, o el archivo EVO_IMAGE (código), o "evo:latest".
# EVO_MIG = última migración de su base; si existe MIGRA_AL_ARRANCAR, arrancar la imagen nueva la cambia (como Evolution real).
# CONFIG_MALA → la revisión de configuración da 2; EVO_PLAN_RC / EVO_VERIFY_RC → códigos de evolution-check (plan / verify).
mkdir -p "$work/bin"
cat > "$work/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo "docker $*" >> "$LOG"
target() { local v; v="$(sed -n 's/^EVOLUTION_IMAGE=//p' .env 2>/dev/null | tail -n 1)"; [[ -n "$v" ]] || v="$(cat EVO_IMAGE 2>/dev/null || true)"; echo "${v:-evo:latest}"; }
start_evolution() { [[ -f EVO_RUNNING ]] || return 0; local t; t="$(target)"; if [[ "$(cat EVO_RUNNING)" != "$t" ]]; then echo "$t" > EVO_RUNNING; [[ -f MIGRA_AL_ARRANCAR ]] && echo "29990101000000_nueva" > EVO_MIG; fi; return 0; }
case "$*" in
  "compose version") echo "Docker Compose version v2" ;;
  *"wget -qO-"*) [[ -f VERSION_MALA ]] && exit 1; echo '{"ok":true}' ;;
  # Salud funcional (backend nuevo con HEALTH_TOKEN). SIN_FUNCIONAL simula un backend anterior que responde 404.
  *"node -e"*"/health/functional"*) [[ -f VERSION_MALA ]] && exit 1; [[ -f SIN_FUNCIONAL ]] && { echo '{"message":"Route GET:/health/functional not found","statusCode":404}'; exit 0; }
    f="$(cat FALLA_NUEVA FALLA_PREVIA 2>/dev/null | tr '\n' ' ')"; first=1
    printf '{"status":"%s","components":[' "${f:+no_disponible}"
    for c in database whatsapp whatsapp_sessions scheduler ai models backup disk queue resources; do
      s=operativo; [[ " $f " == *" $c "* ]] && s=no_disponible
      (( first )) || printf ','; first=0; printf '{"id":"%s","state":"%s","label":"x","detail":"x","verified":true,"actions":[]}' "$c" "$s"
    done; printf ']}' ;;
  # Salud de preparación (formato anterior): lo que el backend anterior medía.
  *"node -e"*"/health/ready"*) [[ -f VERSION_MALA ]] && exit 1; f="$(cat FALLA_NUEVA FALLA_PREVIA 2>/dev/null | tr '\n' ' ')"; first=1
    printf '{"status":"%s","checks":[' "${f:+fail}"
    for c in database whatsapp whatsapp_sessions scheduler ai models backup disk; do
      s=ok; [[ " $f " == *" $c "* ]] && s=fail
      (( first )) || printf ','; first=0; printf '{"name":"%s","status":"%s"}' "$c" "$s"
    done; printf ']}' ;;
  *"backup.sh now"*) [[ -f FALLA_RESPALDO ]] && exit 1; exit 0 ;;
  *"backup sh -c"*) echo "/backups/riverrun-20261010-120000.tar.enc" ;;
  *"images -q backend"*) echo "sha256:abc123" ;;
  "compose config evolution") printf 'services:\n  evolution:\n    image: %s\n  redis:\n    image: redis:7-alpine\n' "$(target)" ;;
  *"config --images"*) echo "plataforma-backend"; cat PG_IMAGE 2>/dev/null || echo "postgres:16-alpine" ;;
  "compose ps -q evolution") [[ -f EVO_RUNNING ]] && echo "evo-contenedor" ;;
  "inspect --format {{.Config.Image}} evo-contenedor") cat EVO_RUNNING ;;
  "inspect --format {{.Image}} evo-contenedor") echo "id-$(cat EVO_RUNNING)" ;;
  "image inspect --format {{.Id}} "*) ref="${*##* }"; [[ -f "PULLED" && "$(cat PULLED)" == "$ref" || "$ref" == "$(cat EVO_RUNNING 2>/dev/null)" ]] && echo "id-$ref" ;;
  "image inspect --format {{range .RepoDigests}}"*) echo "$(cat EVO_RUNNING)@sha256:anterior" ;;
  *"psql -U chatbot -d evolution"*) cat EVO_MIG 2>/dev/null || echo "-" ;;
  *"psql -U chatbot -d chatbot"*) echo "palmas,otra" ;;
  *"config-check.js"*) echo "Configuración (producción): 0 crítico(s)"; [[ -f CONFIG_MALA ]] && { echo "✕ [CRÍTICO] SESSION_SECRET es demasiado corto"; exit 2; }; exit 0 ;;
  *"evolution-check.js plan"*) echo "  plan simulado"; exit "$(cat EVO_PLAN_RC 2>/dev/null || echo 0)" ;;
  *"evolution-check.js verify"*) echo "  verificación simulada"; exit "$(cat EVO_VERIFY_RC 2>/dev/null || echo 0)" ;;
  "compose pull evolution") [[ -f PULL_FALLA ]] && exit 1; target > PULLED ;;
  "compose up -d --no-deps evolution") start_evolution ;;
  "compose up -d --no-build --no-deps backend") ;;
  "compose up -d"*) start_evolution ;;
esac
exit 0
SHIM
chmod +x "$work/bin/docker"; export PATH="$work/bin:$PATH"

git init -q --bare "$work/origin.git"
git clone -q "$work/origin.git" "$work/app" 2>/dev/null
cd "$work/app"
# Estado del docker simulado y .env: nunca entran en los commits de prueba (EVO_IMAGE sí: es "código").
printf '%s\n' .env EVO_RUNNING EVO_MIG EVO_PLAN_RC EVO_VERIFY_RC PULLED MIGRA_AL_ARRANCAR CONFIG_MALA PULL_FALLA FALLA_RESPALDO FALLA_PREVIA SIN_FUNCIONAL > .gitignore
cp "$here/riverrun" . && echo "v1" > VERSION && git add -A && git commit -qm "v1" && git push -q origin HEAD:main 2>/dev/null
git branch -q --set-upstream-to=origin/main 2>/dev/null || git branch -q -u origin/main
# Publica una versión nueva en el "origin" y deja la copia local donde estaba. $3 = imagen de Evolution del código nuevo.
newcommit() {
  local base; base="$(git rev-parse HEAD)"
  git fetch -q origin; git reset -q --hard origin/main
  git rm -q -f --ignore-unmatch VERSION_MALA
  echo "$1" > VERSION
  if [[ -n "${2:-}" ]]; then touch "$2"; fi
  if [[ -n "${3:-}" ]]; then echo "$3" > EVO_IMAGE; fi
  git add -A; git commit -qm "$1"; git push -q origin HEAD:main
  git reset -q --hard "$base"
}
: > "$LOG"
# Nada de lo que hace el flujo puede borrar sesiones de WhatsApp: ni volúmenes, ni "down", ni instancias.
no_session_loss() { ! grep -Eq "compose down|volume rm|rm -v|-v --remove|instance/delete|instance/logout" "$LOG" || { echo "ERROR: operación que borra sesiones"; cat "$LOG"; exit 1; }; }

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
grep -q "up -d --no-build --no-deps backend" "$LOG"

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

echo "== la versión nueva no arrancaría con este .env: se detiene antes de aplicar nada"
: > "$LOG"; newcommit v6; touch CONFIG_MALA
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó con configuración crítica"; exit 1; fi
grep -q "SESSION_SECRET" "$work/out" && grep -q "No se aplicó nada" "$work/out"
[[ "$(cat VERSION)" == v5 ]]; ! grep -q "up -d" "$LOG"; ! grep -q "backup.sh now" "$LOG"
grep -q "docker tag riverrun-backend:previous plataforma-backend" "$LOG" # la imagen ya construida no queda como la actual
rm -f CONFIG_MALA
./riverrun update >/dev/null; [[ "$(cat VERSION)" == v6 ]]

# ---------------------------------------------------------------- Evolution API
echo "evo:latest" > EVO_RUNNING; echo "20251122003044_add_chat_instance_remotejid_unique" > EVO_MIG
PIN="evoapicloud/evolution-api:v2.3.7@sha256:1bd8"

echo "== Evolution: fijar la imagen sin cambio de esquema → respaldo completo, descarga, verificación de sesiones"
: > "$LOG"; newcommit v7 "" "$PIN"
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: debió aplicarse"; exit 1; }
[[ "$(cat VERSION)" == v7 && "$(cat EVO_RUNNING)" == "$PIN" ]]
grep -q "evolution-check.js plan --target $PIN --db-migration 20251122003044" "$LOG"
grep -q "compose pull evolution" "$LOG"
grep -q "BACKUP_VERIFY_ALL=true backup /usr/local/bin/backup.sh now" "$LOG"
grep -q "evolution-check.js verify --previous-open palmas,otra" "$LOG"
[[ "$(grep -n "compose pull evolution" "$LOG" | cut -d: -f1)" -lt "$(grep -n "compose up -d --build" "$LOG" | cut -d: -f1)" ]]
no_session_loss

echo "== Evolution con migraciones: sin confirmación (no interactivo) no se aplica nada"
: > "$LOG"; echo 3 > EVO_PLAN_RC; newcommit v8 "" "evoapicloud/evolution-api:v2.4.0"
if ./riverrun update > "$work/out" 2>&1 < /dev/null; then echo "ERROR: aplicó sin confirmación"; exit 1; fi
grep -q "accept-evolution-change" "$work/out"
[[ "$(cat VERSION)" == v7 && "$(cat EVO_RUNNING)" == "$PIN" ]]
! grep -q "compose pull evolution" "$LOG"; ! grep -q "backup.sh now" "$LOG"; ! grep -q "up -d" "$LOG"

echo "== Evolution incompatible: bloqueado aunque se acepte"
: > "$LOG"; echo 4 > EVO_PLAN_RC
if ./riverrun update --accept-evolution-change > "$work/out" 2>&1; then echo "ERROR: aplicó una versión incompatible"; exit 1; fi
grep -q "no es segura" "$work/out"; ! grep -q "up -d" "$LOG"; [[ "$(cat VERSION)" == v7 ]]

echo "== Evolution: cambiar de versión sin respaldo no se permite"
: > "$LOG"; echo 3 > EVO_PLAN_RC
if ./riverrun update --accept-evolution-change --no-backup > "$work/out" 2>&1; then echo "ERROR: cambió Evolution sin respaldo"; exit 1; fi
grep -q "exige un respaldo" "$work/out"; ! grep -q "up -d" "$LOG"; [[ "$(cat VERSION)" == v7 ]]

echo "== Evolution migró y la verificación falla: NO se baja Evolution; se fija en .env y se explica cómo recuperar"
: > "$LOG"; touch MIGRA_AL_ARRANCAR; echo 2 > EVO_VERIFY_RC
if ./riverrun update --accept-evolution-change > "$work/out" 2>&1; then echo "ERROR: debió fallar"; exit 1; fi
[[ "$(cat VERSION)" == v7 ]] || { cat "$work/out"; echo "ERROR: el backend no volvió ($(cat VERSION))"; exit 1; }
[[ "$(cat EVO_RUNNING)" == "evoapicloud/evolution-api:v2.4.0" ]] || { echo "ERROR: bajó Evolution con la base ya migrada"; exit 1; }
! grep -q "compose up -d --no-deps evolution" "$LOG"
grep -q "^EVOLUTION_IMAGE=evoapicloud/evolution-api:v2.4.0$" .env
grep -q "restaura el respaldo previo" "$work/out"; grep -q "riverrun-20261010-120000.tar.enc" "$work/out"; grep -q "No se borró ni se recreó ninguna instancia" "$work/out"
no_session_loss
# Ningún reinicio cambia Evolution por accidente después de esto.
./riverrun restart > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: restart debió funcionar"; exit 1; }
[[ "$(cat EVO_RUNNING)" == "evoapicloud/evolution-api:v2.4.0" ]]
# Recuperación manual: se vuelve a la versión verificada desde el respaldo (aquí solo se simula la fijación).
sed -i '/^EVOLUTION_IMAGE=/d' .env; rm -f MIGRA_AL_ARRANCAR EVO_VERIFY_RC
echo "$PIN" > EVO_RUNNING; echo "20251122003044_add_chat_instance_remotejid_unique" > EVO_MIG

echo "== Evolution sin cambio de esquema y verificación fallida: vuelve a la imagen anterior (es seguro)"
: > "$LOG"; echo 0 > EVO_PLAN_RC; echo 2 > EVO_VERIFY_RC; newcommit v9 "" "evoapicloud/evolution-api:v2.3.8"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: debió fallar"; exit 1; fi
grep -q "compose up -d --no-deps evolution" "$LOG"
[[ "$(cat EVO_RUNNING)" == "$PIN" && "$(cat VERSION)" == v7 ]] || { echo "ERROR: no volvió a la imagen anterior de Evolution"; exit 1; }
! grep -q "^EVOLUTION_IMAGE=" .env
no_session_loss
rm -f EVO_VERIFY_RC

echo "== si no se puede leer el esquema de Evolution, tampoco se baja (se trata como migrado)"
: > "$LOG"; echo "?" > EVO_MIG; echo 3 > EVO_PLAN_RC; echo 2 > EVO_VERIFY_RC; newcommit v9e "" "evoapicloud/evolution-api:v2.3.9"
if ./riverrun update --accept-evolution-change > "$work/out" 2>&1; then echo "ERROR: debió fallar"; exit 1; fi
! grep -q "compose up -d --no-deps evolution" "$LOG"; grep -q "^EVOLUTION_IMAGE=evoapicloud/evolution-api:v2.3.9$" .env
sed -i '/^EVOLUTION_IMAGE=/d' .env; rm -f EVO_VERIFY_RC; echo 0 > EVO_PLAN_RC
echo "$PIN" > EVO_RUNNING; echo "20251122003044_add_chat_instance_remotejid_unique" > EVO_MIG

echo "== restart no aplica a escondidas una imagen de Evolution distinta; tampoco con configuración crítica"
: > "$LOG"; echo "EVOLUTION_IMAGE=evoapicloud/evolution-api:v2.3.6" >> .env
if ./riverrun restart > "$work/out" 2>&1; then echo "ERROR: restart cambió Evolution"; exit 1; fi
grep -q "./riverrun update" "$work/out"; ! grep -q "up -d" "$LOG"
sed -i '/^EVOLUTION_IMAGE=/d' .env; touch CONFIG_MALA
if ./riverrun restart > "$work/out" 2>&1; then echo "ERROR: restart con configuración crítica"; exit 1; fi
! grep -q "up -d" "$LOG"; rm -f CONFIG_MALA

echo "== sin código nuevo, EVOLUTION_IMAGE cambiada en .env: update la aplica con el mismo cuidado"
git fetch -q origin; git reset -q --hard origin/main; : > "$LOG"   # al día con el código (v9)
echo "$PIN" > EVO_RUNNING; echo 0 > EVO_PLAN_RC
echo "EVOLUTION_IMAGE=evoapicloud/evolution-api:v2.3.7-otra" >> .env
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: debió aplicarse"; exit 1; }
grep -q "imagen de Evolution configurada cambió" "$work/out"; grep -q "compose pull evolution" "$LOG"; grep -q "BACKUP_VERIFY_ALL=true" "$LOG"
[[ "$(cat EVO_RUNNING)" == "evoapicloud/evolution-api:v2.3.7-otra" ]]
no_session_loss
echo "== salud: lo que ya fallaba no bloquea; una comprobación que la versión nueva rompe hace volver atrás"
: > "$LOG"; echo "ai" > FALLA_PREVIA; newcommit v9b
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: una falla previa bloqueó la actualización"; exit 1; }
grep -q "Ya fallaba antes de actualizar: ai" "$work/out"; [[ "$(cat VERSION)" == v9b ]]
: > "$LOG"; base="$(git rev-parse HEAD)"; git fetch -q origin; git reset -q --hard origin/main
echo "whatsapp" > FALLA_NUEVA; echo v9c > VERSION; git add -A; git commit -qm v9c; git push -q origin HEAD:main; git reset -q --hard "$base"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó una versión que rompe una comprobación"; exit 1; fi
grep -q "falla (antes no): whatsapp" "$work/out"; [[ "$(cat VERSION)" == v9b && ! -f FALLA_NUEVA ]]
grep -q "up -d --no-build --no-deps backend" "$LOG"
rm -f FALLA_PREVIA
git fetch -q origin; git reset -q --hard origin/main; git rm -q FALLA_NUEVA; echo v9d > VERSION; git commit -qam v9d; git push -q origin HEAD:main; git reset -q --hard "$base"
./riverrun update >/dev/null 2>&1 || { echo "ERROR: no se recuperó"; exit 1; }

echo "== si el propio procedimiento cambia, update continúa con el riverrun recién descargado"
: > "$LOG"
base="$(git rev-parse HEAD)"; git fetch -q origin; git reset -q --hard origin/main
echo "# procedimiento nuevo" >> riverrun; echo v10 > VERSION; git add -A; git commit -qm v10; git push -q origin HEAD:main; git reset -q --hard "$base"
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: debió aplicarse"; exit 1; }
grep -q "se continúa con el nuevo" "$work/out" && grep -q "Continuando con el procedimiento de actualización nuevo" "$work/out"
[[ "$(cat VERSION)" == v10 ]] && tail -n 1 riverrun | grep -q "procedimiento nuevo"
[[ "$(grep -c "backup.sh now" "$LOG")" == 1 ]] || { echo "ERROR: el respaldo se repitió"; exit 1; }
echo "== rotate-secret: sin confirmación no cambia nada; con confirmación respalda antes y no imprime el secreto"
echo "SESSION_SECRET=viejo-secreto-de-prueba" >> .env
: > "$LOG"
if printf 'nope\n' | ./riverrun rotate-secret > "$work/out" 2>&1; then echo "ERROR: cambió sin confirmación"; exit 1; fi
grep -q "^SESSION_SECRET=viejo-secreto-de-prueba$" .env
! grep -q "backup.sh now" "$LOG"
touch FALLA_RESPALDO
if printf 'ROTAR SESSION_SECRET\n' | ./riverrun rotate-secret > "$work/out" 2>&1; then echo "ERROR: cambió sin respaldo"; exit 1; fi
grep -q "^SESSION_SECRET=viejo-secreto-de-prueba$" .env
rm -f FALLA_RESPALDO
: > "$LOG"
printf 'ROTAR SESSION_SECRET\n' | ./riverrun rotate-secret > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: rotación fallida"; exit 1; }
grep -Eq "^SESSION_SECRET=[0-9a-f]{64}$" .env && ! grep -q "viejo-secreto" .env
nuevo="$(sed -n 's/^SESSION_SECRET=//p' .env)"
! grep -q "$nuevo" "$work/out" || { echo "ERROR: el secreto nuevo se imprimió"; exit 1; }
b="$(grep -n "backup.sh now" "$LOG" | head -n 1 | cut -d: -f1)"; u="$(grep -n "up -d backend" "$LOG" | head -n 1 | cut -d: -f1)"
[[ -n "$b" && -n "$u" && "$b" -lt "$u" ]] || { echo "ERROR: el respaldo debe hacerse antes de reiniciar"; exit 1; }
echo "== salud funcional: la actualización genera HEALTH_TOKEN (sin imprimirlo) y consulta /health/functional"
: > "$LOG"; newcommit v12
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: la actualización con salud funcional falló"; exit 1; }
grep -Eq "^HEALTH_TOKEN=[0-9a-f]{64}$" .env || { echo "ERROR: falta HEALTH_TOKEN en .env"; exit 1; }
tok="$(sed -n 's/^HEALTH_TOKEN=//p' .env)"
! grep -q "$tok" "$work/out" || { echo "ERROR: el token se imprimió"; exit 1; }
grep -q "/health/functional" "$LOG" || { echo "ERROR: no consultó /health/functional"; exit 1; }
[[ "$(cat VERSION)" == v12 ]]

echo "== backend anterior sin /health/functional: se compara con /health/ready y una falla nueva sí vuelve atrás"
: > "$LOG"; touch SIN_FUNCIONAL; base="$(git rev-parse HEAD)"; git fetch -q origin; git reset -q --hard origin/main
echo "database" > FALLA_NUEVA; echo v13 > VERSION; git add -A; git commit -qm v13; git push -q origin HEAD:main; git reset -q --hard "$base"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó una versión que rompe la base de datos (según /health/ready)"; exit 1; fi
grep -q "falla (antes no): database" "$work/out"; [[ "$(cat VERSION)" == v12 ]]
rm -f SIN_FUNCIONAL FALLA_NUEVA

echo "== preflight: sin .env bloquea"
mv .env .env.lejos
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 1 ]] && grep -q "Falta .env" "$work/out" && grep -q "BLOQUEADO" "$work/out" || { cat "$work/out"; echo "ERROR: sin .env la revisión debía bloquear"; exit 1; }
mv .env.lejos .env

echo "== preflight: todo en orden aprueba lo revisado y deja sin verificar lo que requiere red o servicios"
cp .env .env.keep
printf 'DOMAIN=pms.ejemplo.mx\nEVOLUTION_IMAGE=evoapicloud/evolution-api:v2.3.7@sha256:abc\n' >> .env; chmod 600 .env
grep -Eq "^HEALTH_TOKEN=.{16,}$" .env || { echo "ERROR: el .env de prueba no tiene HEALTH_TOKEN"; exit 1; }
export RIVERRUN_PREFLIGHT_MEM_KB=2097152 RIVERRUN_PREFLIGHT_DISK_KB=20971520 RIVERRUN_PREFLIGHT_CPUS=2
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && grep -q "SIN BLOQUEOS EN LO REVISADO" "$work/out" && grep -q "No verificado: último respaldo" "$work/out" && grep -q "Envíos reales habilitados" "$work/out" || { cat "$work/out"; echo "ERROR: con todo en orden debía pasar sin bloqueos"; exit 1; }
! grep -q "APROBADO\." "$work/out" || { echo "ERROR: no debe afirmar aprobación completa con comprobaciones sin verificar"; exit 1; }

echo "== preflight: modo sandbox avisa; disco insuficiente y configuración crítica bloquean"
printf 'OUTBOUND_MODE=sandbox\n' >> .env
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && grep -q "APROBADO CON ADVERTENCIAS" "$work/out" && grep -q "OUTBOUND_MODE=sandbox" "$work/out" || { cat "$work/out"; echo "ERROR: sandbox debía advertir"; exit 1; }
export RIVERRUN_PREFLIGHT_DISK_KB=1048576
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 1 ]] && grep -q "Disco libre: 1 GB" "$work/out" && grep -q "BLOQUEADO" "$work/out" || { cat "$work/out"; echo "ERROR: poco disco debía bloquear"; exit 1; }
export RIVERRUN_PREFLIGHT_DISK_KB=20971520; touch CONFIG_MALA
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 1 ]] && grep -q "Configuración con problemas críticos" "$work/out" || { cat "$work/out"; echo "ERROR: configuración crítica debía bloquear"; exit 1; }
rm -f CONFIG_MALA
mv -f .env.keep .env; unset RIVERRUN_PREFLIGHT_MEM_KB RIVERRUN_PREFLIGHT_DISK_KB RIVERRUN_PREFLIGHT_CPUS

echo "== preflight en línea sin servicios levantados: lo que no se comprueba se dice; opción desconocida se rechaza"
set +e; ./riverrun preflight > "$work/out" 2>&1; rc=$?; set -e
grep -q "servicios en marcha (no están levantados" "$work/out" && grep -q "HTTPS público" "$work/out" || { cat "$work/out"; echo "ERROR: la revisión en línea no marcó lo no verificado"; exit 1; }
set +e; ./riverrun preflight --raro > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "Opción desconocida" "$work/out" || { echo "ERROR: aceptó una opción desconocida"; exit 1; }
./riverrun help | grep -q "preflight" || { echo "ERROR: la ayuda no menciona preflight"; exit 1; }

echo "OK: el flujo de actualización funciona"
