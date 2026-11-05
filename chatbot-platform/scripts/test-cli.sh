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
export RIVERRUN_OBSERVE_SECONDS=3 RIVERRUN_OBSERVE_POLL=1
LOG="$work/docker.log"; export LOG

# docker simulado: registra cada llamada; la salud falla si existe VERSION_MALA en el directorio actual; el respaldo falla si existe FALLA_RESPALDO.
# El re-cifrado del 2FA guarda en REKEY_IN lo que recibe por la entrada y falla si existe FALLA_REKEY.
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
    # Cada consulta cuenta. FALLA_TARDIA=N hace fallar la consulta N-ésima; con FALLA_SOSTENIDA, desde la N-ésima en adelante.
    n=$(( $(cat HEALTH_N 2>/dev/null || echo 0) + 1 )); echo "$n" > HEALTH_N
    extra=""
    if [[ -f FALLA_TARDIA ]]; then
      d="$(cat FALLA_TARDIA)"
      if [[ -f FALLA_SOSTENIDA ]]; then (( n >= d )) && extra=whatsapp; else (( n == d )) && extra=whatsapp; fi
    fi
    f="$(cat FALLA_NUEVA FALLA_PREVIA 2>/dev/null | tr '\n' ' ') $extra"; first=1
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
  *"exec -T backend node dist/cli/rekey-secrets.js"*) [[ -f FALLA_REKEY ]] && exit 1; echo "Secretos re-cifrados: 2" ;;
  *"backup sh -c"*) echo "/backups/riverrun-20261010-120000.tar.enc" ;;
  *"images -q backend"*) echo "sha256:abc123" ;;
  "compose config evolution") printf 'services:\n  evolution:\n    image: %s\n  redis:\n    image: redis:7-alpine\n' "$(target)" ;;
  *"config --images"*) echo "plataforma-backend"; cat PG_IMAGE 2>/dev/null || echo "postgres:16-alpine" ;;
  "compose ps -q evolution") [[ -f EVO_RUNNING ]] && echo "evo-contenedor" ;;
  "inspect --format {{.Config.Image}} evo-contenedor") cat EVO_RUNNING ;;
  "inspect --format {{.Image}} evo-contenedor") echo "id-$(cat EVO_RUNNING)" ;;
  "image inspect --format {{.Id}} "*) ref="${*##* }"; [[ -f "PULLED" && "$(cat PULLED)" == "$ref" || "$ref" == "$(cat EVO_RUNNING 2>/dev/null)" ]] && echo "id-$ref" ;;
  # PostgreSQL: el contenedor que corre y los digests de su imagen (PG_DIGESTS, uno por línea).
  "compose ps -q postgres") echo "pg-contenedor" ;;
  "inspect --format {{.Image}} pg-contenedor") echo "id-pg" ;;
  "image inspect --format {{range .RepoDigests}}{{println .}}{{end}} id-pg") cat PG_DIGESTS 2>/dev/null || true ;;
  "image inspect --format {{range .RepoDigests}}"*) echo "$(cat EVO_RUNNING)@sha256:anterior" ;;
  # Usuarios de PostgreSQL por servicio: guarda lo que recibe (las contraseñas y docker/db-roles.sql).
  *"psql -X -q -U chatbot -d postgres"*) cat > ROLES_IN; [[ -f FALLA_ROLES ]] && exit 1; exit 0 ;;
  *"pg_isready"*) exit 0 ;;
  *"psql -U chatbot -d evolution"*) cat EVO_MIG 2>/dev/null || echo "-" ;;
  *"psql -U chatbot -d chatbot"*) echo "palmas,otra" ;;
  *"config-check.js"*) [[ -f CONFIG_NO_CORRE ]] && exit 5; echo "Configuración (producción): 0 crítico(s)"; [[ -f CONFIG_MALA ]] && { echo "✕ [CRÍTICO] SESSION_SECRET es demasiado corto"; exit 2; }; exit 0 ;;
  *"evolution-check.js plan"*) echo "  plan simulado"; exit "$(cat EVO_PLAN_RC 2>/dev/null || echo 0)" ;;
  *"evolution-check.js verify"*) echo "  verificación simulada"; exit "$(cat EVO_VERIFY_RC 2>/dev/null || echo 0)" ;;
  "compose pull evolution") [[ -f PULL_FALLA ]] && exit 1; target > PULLED ;;
  "compose up -d --no-deps evolution") start_evolution ;;
  "compose up -d --no-build --no-deps backend") ;;
  "compose up -d"*) start_evolution ;;
esac
exit 0
SHIM
# curl simulado para la API de GitHub (INF-4): las consultas de check-runs devuelven CI_RESPUESTA (o fallan sin él).
cat > "$work/bin/curl" <<'SHIM'
#!/usr/bin/env bash
for a in "$@"; do
  if [[ "$a" == *"/actions/workflows/"* ]]; then
    echo "curl $a" >> "$LOG"; o=""; prev=""
    for b in "$@"; do [[ "$prev" == "-o" ]] && o="$b"; prev="$b"; done
    [[ -f CI_RESPUESTA ]] || exit 6
    cp CI_RESPUESTA "$o"
    printf '%s' "$(cat CI_CODIGO 2>/dev/null || echo 200)"; exit 0
  fi
done
exec /usr/bin/curl "$@"
SHIM
chmod +x "$work/bin/curl"
chmod +x "$work/bin/docker"; export PATH="$work/bin:$PATH"

git init -q --bare "$work/origin.git"
git clone -q "$work/origin.git" "$work/app" 2>/dev/null
cd "$work/app"
# Estado del docker simulado y .env: nunca entran en los commits de prueba (EVO_IMAGE sí: es "código").
printf '%s\n' .env EVO_RUNNING EVO_MIG EVO_PLAN_RC EVO_VERIFY_RC PULLED MIGRA_AL_ARRANCAR CONFIG_MALA PULL_FALLA FALLA_RESPALDO FALLA_PREVIA SIN_FUNCIONAL CONFIG_NO_CORRE HEALTH_N FALLA_TARDIA FALLA_SOSTENIDA REKEY_IN FALLA_REKEY ROLES_IN FALLA_ROLES CI_RESPUESTA CI_CODIGO PG_DIGESTS > .gitignore
cp "$here/riverrun" . && mkdir -p docker && cp "$here/docker/db-roles.sql" docker/ && echo "v1" > VERSION && git add -A && git commit -qm "v1" && git push -q origin HEAD:main 2>/dev/null
git branch -q --set-upstream-to=origin/main 2>/dev/null || git branch -q -u origin/main
# Publica una versión nueva en el "origin" y deja la copia local donde estaba. $3 = imagen de Evolution del código nuevo.
newcommit() {
  local base; base="$(git rev-parse HEAD)"
  git fetch -q origin; git reset -q --hard origin/main
  git rm -q -f --ignore-unmatch VERSION_MALA FALLA_NUEVA
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
# INF-3: la base de Node y del respaldo con parches (--pull), y Redis y Caddy de su misma etiqueta.
grep -q "compose build --pull backend backup" "$LOG" || { cat "$LOG"; echo "ERROR: no construyó con --pull"; exit 1; }
grep -q "compose pull --quiet redis caddy pdf" "$LOG" || { echo "ERROR: no descargó Redis, Caddy ni el convertidor de PDF"; exit 1; }
# INF-2: usuarios de PostgreSQL por servicio (después del respaldo, antes de levantar) y Redis con contraseña.
grep -q "set app_pw '" ROLES_IN && grep -q "riverrun_app" ROLES_IN || { echo "ERROR: no corrió db-roles.sql"; exit 1; }
[[ "$(grep -n "backup.sh now" "$LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n "psql -X -q -U chatbot -d postgres" "$LOG" | head -1 | cut -d: -f1)" ]] || { echo "ERROR: los usuarios de PostgreSQL antes del respaldo"; exit 1; }
grep -q "^DB_APP_USER=riverrun_app$" .env && grep -Eq "^DB_APP_PASSWORD=.{40,}$" .env && grep -q "^DB_EVOLUTION_USER=riverrun_evolution$" .env && grep -Eq "^REDIS_PASSWORD=.{40,}$" .env || { cat .env; echo "ERROR: faltan usuarios o contraseñas en .env"; exit 1; }
app_pw="$(sed -n 's/^DB_APP_PASSWORD=//p' .env)"

echo "== usuarios de PostgreSQL: si fallan no se aplica la versión; al repetir, las contraseñas no cambian"
: > "$LOG"; newcommit v2b; touch FALLA_ROLES
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: actualizó sin los usuarios de PostgreSQL"; exit 1; fi
[[ "$(cat VERSION)" == v2 ]] && ! grep -q "up -d --build" "$LOG" || { echo "ERROR: aplicó la versión con db-roles fallido"; exit 1; }
rm -f FALLA_ROLES
./riverrun update >/dev/null
[[ "$(cat VERSION)" == v2b && "$(sed -n 's/^DB_APP_PASSWORD=//p' .env)" == "$app_pw" ]] || { echo "ERROR: cambió la contraseña de la app al repetir"; exit 1; }

echo "== versión nueva enferma: vuelve a la anterior"
: > "$LOG"
newcommit v3-mala VERSION_MALA
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: debió fallar"; exit 1; fi
[[ "$(cat VERSION)" == v2b && ! -f VERSION_MALA ]] || { echo "ERROR: no volvió al código anterior"; exit 1; }
grep -q "docker tag sha256:abc123 riverrun-backend:previous" "$LOG"
grep -q "docker tag riverrun-backend:previous plataforma-backend" "$LOG"
grep -q "up -d --no-build --no-deps backend" "$LOG"
# La base y Redis vuelven a la configuración anterior antes que el backend (INF-2: red interna y contraseña de Redis).
[[ "$(grep -n "up -d --no-build --no-deps postgres redis" "$LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n "up -d --no-build --no-deps backend" "$LOG" | head -1 | cut -d: -f1)" ]] || { cat "$LOG"; echo "ERROR: la vuelta atrás no regresó la base y Redis antes del backend"; exit 1; }

echo "== sin respaldo no se actualiza"
: > "$LOG"; newcommit v4
touch FALLA_RESPALDO
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: actualizó sin respaldo"; exit 1; fi
[[ "$(cat VERSION)" == v2b ]]
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

echo "== la misma etiqueta de PostgreSQL ahora fijada por digest: sigue si es la imagen que corre; si no, se detiene"
# INF-17: el compose pasa de «pgvector/pgvector:0.8.7-pg16» a «…@sha256:…» y riverrun cambia en el mismo commit, así que
# update se relanza con --pg-before (el texto anterior, sin digest).
: > "$LOG"
base="$(git rev-parse HEAD)"; git fetch -q origin; git reset -q --hard origin/main
echo "pgvector/pgvector:0.8.7-pg16@sha256:fijada" > PG_IMAGE; echo "# imágenes por digest" >> riverrun; echo v5b > VERSION
git add -A; git commit -qm v5b; git push -q origin HEAD:main; git reset -q --hard "$base"
echo "pgvector/pgvector@sha256:otra" > PG_DIGESTS
if ./riverrun update > "$work/out" 2>&1; then cat "$work/out"; echo "ERROR: aplicó otra compilación de la misma etiqueta de PostgreSQL"; exit 1; fi
grep -q "misma etiqueta" "$work/out" && grep -q "otra compilación" "$work/out" && grep -q "accept-db-image-change" "$work/out" \
  || { cat "$work/out"; echo "ERROR: falta el mensaje de otra compilación de la misma etiqueta"; exit 1; }
[[ "$(cat VERSION)" == v5 ]] && ! grep -q "up -d --build" "$LOG" || { echo "ERROR: no revirtió el código"; exit 1; }
printf '%s\n' "pgvector/pgvector@sha256:otra" "pgvector/pgvector@sha256:fijada" > PG_DIGESTS
: > "$LOG"
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: se detuvo aunque corre exactamente esa imagen"; exit 1; }
[[ "$(cat VERSION)" == v5b ]] && grep -q "se continúa con el nuevo" "$work/out" || { cat "$work/out"; echo "ERROR: no aplicó por el relanzamiento"; exit 1; }

echo "== con cambios hechos a mano se niega"
echo "cambio" >> VERSION
if ./riverrun update >/dev/null 2>&1; then echo "ERROR: actualizó con cambios locales"; exit 1; fi
git checkout -q VERSION

echo "== la versión nueva no arrancaría con este .env: se detiene antes de aplicar nada"
: > "$LOG"; newcommit v6; touch CONFIG_MALA
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó con configuración crítica"; exit 1; fi
grep -q "SESSION_SECRET" "$work/out" && grep -q "No se aplicó nada" "$work/out"
[[ "$(cat VERSION)" == v5b ]]; ! grep -q "up -d" "$LOG"; ! grep -q "backup.sh now" "$LOG"
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
# La actualización generó DATA_KEY (INF-6) sin imprimirla.
grep -Eq "^DATA_KEY=[0-9a-f]{64}$" .env || { echo "ERROR: falta DATA_KEY en .env"; exit 1; }
dk="$(sed -n 's/^DATA_KEY=//p' .env)"
# Si no se puede re-cifrar con la llave de datos, .env conserva el secreto de antes y no se reinicia nada.
: > "$LOG"; touch FALLA_REKEY
if printf 'ROTAR SESSION_SECRET\n' | ./riverrun rotate-secret > "$work/out" 2>&1; then echo "ERROR: cambió sin re-cifrar"; exit 1; fi
grep -q "No se pudieron re-cifrar los secretos con la llave de datos: no se cambió SESSION_SECRET." "$work/out"
grep -q "^SESSION_SECRET=viejo-secreto-de-prueba$" .env
! grep -q "up -d backend" "$LOG" || { echo "ERROR: reinició sin re-cifrar"; exit 1; }
rm -f FALLA_REKEY
: > "$LOG"
printf 'ROTAR SESSION_SECRET\n' | ./riverrun rotate-secret > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: rotación fallida"; exit 1; }
grep -Eq "^SESSION_SECRET=[0-9a-f]{64}$" .env && ! grep -q "viejo-secreto" .env
grep -q "no hay que volver a conectar nada" "$work/out"
[[ "$(sed -n 's/^DATA_KEY=//p' .env)" == "$dk" ]] || { echo "ERROR: rotate-secret cambió DATA_KEY"; exit 1; }
nuevo="$(sed -n 's/^SESSION_SECRET=//p' .env)"
! grep -q "$nuevo" "$work/out" || { echo "ERROR: el secreto nuevo se imprimió"; exit 1; }
! grep -q "$nuevo" "$LOG" || { echo "ERROR: el secreto nuevo quedó en los argumentos"; exit 1; }
b="$(grep -n "backup.sh now" "$LOG" | head -n 1 | cut -d: -f1)"; k="$(grep -n "rekey-secrets.js" "$LOG" | head -n 1 | cut -d: -f1)"; u="$(grep -n "up -d backend" "$LOG" | head -n 1 | cut -d: -f1)"
[[ -n "$b" && -n "$k" && -n "$u" && "$b" -lt "$k" && "$k" -lt "$u" ]] || { echo "ERROR: el orden debe ser respaldo → re-cifrado → reinicio"; exit 1; }

echo "== rotate-data-key: la anterior queda en DATA_KEYS_OLD, el backend arranca con las dos y luego se re-cifra"
: > "$LOG"
if printf 'nope\n' | ./riverrun rotate-data-key > "$work/out" 2>&1; then echo "ERROR: cambió sin confirmación"; exit 1; fi
[[ "$(sed -n 's/^DATA_KEY=//p' .env)" == "$dk" ]]
printf 'ROTAR DATA_KEY\n' | ./riverrun rotate-data-key > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: rotación de DATA_KEY fallida"; exit 1; }
nk="$(sed -n 's/^DATA_KEY=//p' .env)"
[[ "$nk" =~ ^[0-9a-f]{64}$ && "$nk" != "$dk" ]] || { echo "ERROR: DATA_KEY no cambió"; exit 1; }
[[ "$(sed -n 's/^DATA_KEYS_OLD=//p' .env)" == "$dk" ]] || { echo "ERROR: la anterior no quedó en DATA_KEYS_OLD"; exit 1; }
! grep -q "$nk" "$work/out" && ! grep -q "$nk" "$LOG" || { echo "ERROR: la llave nueva se imprimió"; exit 1; }
b="$(grep -n "backup.sh now" "$LOG" | head -n 1 | cut -d: -f1)"; u="$(grep -n "up -d backend" "$LOG" | head -n 1 | cut -d: -f1)"; k="$(grep -n "rekey-secrets.js" "$LOG" | head -n 1 | cut -d: -f1)"
[[ -n "$b" && -n "$k" && -n "$u" && "$b" -lt "$u" && "$u" -lt "$k" ]] || { echo "ERROR: el orden debe ser respaldo → reinicio con las dos llaves → re-cifrado"; exit 1; }
echo "== salud funcional: la actualización genera HEALTH_TOKEN (sin imprimirlo) y consulta /health/functional"
: > "$LOG"; newcommit v12
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: la actualización con salud funcional falló"; exit 1; }
grep -Eq "^HEALTH_TOKEN=[0-9a-f]{64}$" .env || { echo "ERROR: falta HEALTH_TOKEN en .env"; exit 1; }
tok="$(sed -n 's/^HEALTH_TOKEN=//p' .env)"
! grep -q "$tok" "$work/out" || { echo "ERROR: el token se imprimió"; exit 1; }
grep -q "/health/functional" "$LOG" || { echo "ERROR: no consultó /health/functional"; exit 1; }
[[ "$(cat VERSION)" == v12 ]]

echo "== INF-4: con código de GitHub, solo se despliega un commit con su CI (ci.yml) terminado y en verde"
export RIVERRUN_GITHUB_REPO=dueno/riverrun
# Como la API de Actions: la corrida más reciente primero; sus objetos anidados no traen status ni conclusion.
ci() { printf '{\n  "total_count": %s,\n  "workflow_runs": [%s]\n}' "$1" "$2" > CI_RESPUESTA; }
run() { printf '{"id": 1, "name": "CI", "head_sha": "x", "status": "%s", "conclusion": %s, "head_commit": {"message": "m"}}' "$1" "$2"; }
: > "$LOG"; newcommit v12b
ci 2 "$(run completed '"failure"'), $(run completed '"success"')"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó con el CI en rojo"; exit 1; fi
grep -q "no está en verde (failure)" "$work/out" && [[ "$(cat VERSION)" == v12 ]] || { cat "$work/out"; echo "ERROR: el CI en rojo debía detener todo"; exit 1; }
! grep -q "backup.sh now" "$LOG" || { echo "ERROR: respaldó antes de comprobar el CI"; exit 1; }
grep -q "/repos/dueno/riverrun/actions/workflows/ci.yml/runs?head_sha=$(git rev-parse origin/main)" "$LOG" || { cat "$LOG"; echo "ERROR: no consultó el CI del commit exacto"; exit 1; }
ci 1 "$(run in_progress null)"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó con el CI corriendo"; exit 1; fi
grep -q "todavía está corriendo" "$work/out" && [[ "$(cat VERSION)" == v12 ]] || { cat "$work/out"; echo "ERROR: el CI sin terminar debía detener todo"; exit 1; }
ci 0 ""
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó un commit sin CI"; exit 1; fi
grep -q "no tiene una corrida del CI" "$work/out" || { cat "$work/out"; echo "ERROR: sin CI debía detener todo"; exit 1; }
rm -f CI_RESPUESTA
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó sin poder consultar el CI"; exit 1; fi
grep -q "No se pudo consultar el CI" "$work/out" || { cat "$work/out"; echo "ERROR: sin respuesta de GitHub debía detener todo"; exit 1; }
echo 404 > CI_CODIGO; ci 1 "$(run completed '"success"')"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó con GitHub respondiendo 404"; exit 1; fi
grep -q "UPDATE_GITHUB_TOKEN" "$work/out" || { cat "$work/out"; echo "ERROR: un 404 debía sugerir el token"; exit 1; }
rm -f CI_CODIGO
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: con el CI en verde debía aplicarse"; exit 1; }
grep -q "CI en verde" "$work/out" && [[ "$(cat VERSION)" == v12b ]] || { cat "$work/out"; echo "ERROR: no aplicó con el CI en verde"; exit 1; }
: > "$LOG"; newcommit v12c
ci 1 "$(run completed '"failure"')"
./riverrun update --skip-ci-check > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: --skip-ci-check debía aplicar"; exit 1; }
grep -q "Se omite la comprobación del CI" "$work/out" && [[ "$(cat VERSION)" == v12c ]] || { cat "$work/out"; echo "ERROR: --skip-ci-check debía avisar y aplicar"; exit 1; }
rm -f CI_RESPUESTA; unset RIVERRUN_GITHUB_REPO

echo "== volver atrás a una versión sin llave de datos: antes se pasan los secretos a su formato (INF-6/INF-7)"
base="$(git rev-parse HEAD)"; git fetch -q origin; git reset -q --hard origin/main
mkdir -p src/cli; echo "// nueva" > src/cli/rekey-secrets.ts; touch VERSION_MALA; echo v12d > VERSION
git add -A; git commit -qm v12d; git push -q origin HEAD:main; git reset -q --hard "$base"
: > "$LOG"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó una versión que no queda sana"; exit 1; fi
grep -q "node dist/cli/rekey-secrets.js --to-legacy" "$LOG" || { cat "$work/out"; echo "ERROR: no pasó los secretos al formato anterior antes de volver"; exit 1; }
grep -q "se pasan a su formato antes de volver" "$work/out" && [[ "$(cat VERSION)" == v12c ]] || { cat "$work/out"; echo "ERROR: debía volver a v12c"; exit 1; }
# El origen queda con una versión limpia (sin esos archivos) para lo que sigue.
git fetch -q origin; base="$(git rev-parse HEAD)"; git reset -q --hard origin/main
git rm -q -r src VERSION_MALA; echo v12e > VERSION; git commit -qm v12e; git push -q origin HEAD:main; git reset -q --hard "$base"

echo "== backend anterior sin /health/functional: se compara con /health/ready y una falla nueva sí vuelve atrás"
: > "$LOG"; touch SIN_FUNCIONAL; base="$(git rev-parse HEAD)"; git fetch -q origin; git reset -q --hard origin/main
echo "database" > FALLA_NUEVA; echo v13 > VERSION; git add -A; git commit -qm v13; git push -q origin HEAD:main; git reset -q --hard "$base"
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó una versión que rompe la base de datos (según /health/ready)"; exit 1; fi
grep -q "falla (antes no): database" "$work/out"; [[ "$(cat VERSION)" == v12c ]]
rm -f SIN_FUNCIONAL FALLA_NUEVA

echo "== preflight: sin .env bloquea"
mv .env .env.lejos
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 1 ]] && grep -q "Falta .env" "$work/out" && grep -q "BLOQUEADO" "$work/out" || { cat "$work/out"; echo "ERROR: sin .env la revisión debía bloquear"; exit 1; }
mv .env.lejos .env

echo "== preflight: todo en orden aprueba lo revisado y deja sin verificar lo que requiere red o servicios"
cp .env .env.keep
# «Todo en orden» incluye las alertas fuera del panel (correo y latido); sin ellas el preflight avisa, como debe.
printf 'DOMAIN=pms.ejemplo.mx\nEVOLUTION_IMAGE=evoapicloud/evolution-api:v2.3.7@sha256:abc\nSMTP_URL=smtp://avisos:clave@smtp.ejemplo.mx:587\nSUPERADMIN_EMAIL=dueno@ejemplo.mx\nHEARTBEAT_URL=https://hc-ping.com/0000\n' >> .env; chmod 600 .env
# INF-21: «todo en orden» incluye exigir la firma del commit en update.
: > "$work/firmantes"; printf 'UPDATE_ALLOWED_SIGNERS=%s\n' "$work/firmantes" >> .env
grep -Eq "^HEALTH_TOKEN=.{16,}$" .env || { echo "ERROR: el .env de prueba no tiene HEALTH_TOKEN"; exit 1; }
export RIVERRUN_PREFLIGHT_MEM_KB=2097152 RIVERRUN_PREFLIGHT_DISK_KB=20971520 RIVERRUN_PREFLIGHT_CPUS=2
# Sin ./riverrun harden, preflight lo avisa; con su marca, no.
mkdir -p "$work/pfetc"; export RIVERRUN_PREFLIGHT_ETC="$work/pfetc"
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && grep -q "no se ha endurecido: sudo ./riverrun harden" "$work/out" || { cat "$work/out"; echo "ERROR: preflight no avisó que falta harden"; exit 1; }
echo "harden 2026-11-03T00:00:00Z" > "$work/pfetc/riverrun-harden"
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && grep -q "SIN BLOQUEOS EN LO REVISADO" "$work/out" && grep -q "No verificado: último respaldo" "$work/out" && grep -q "Envíos reales habilitados" "$work/out" || { cat "$work/out"; echo "ERROR: con todo en orden debía pasar sin bloqueos"; exit 1; }
! grep -q "APROBADO\." "$work/out" || { echo "ERROR: no debe afirmar aprobación completa con comprobaciones sin verificar"; exit 1; }
grep -q "El panel solo escucha en el propio servidor" "$work/out" || { cat "$work/out"; echo "ERROR: no revisó PANEL_BIND"; exit 1; }

echo "== preflight: Redis sin contraseña y update sin firma avisan (INF-19, INF-21)"
cp .env .env.redis
printf 'REDIS_PASSWORD=\nUPDATE_ALLOWED_SIGNERS=\n' >> .env
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && grep -q "Redis sin contraseña (REDIS_PASSWORD vacío)" "$work/out" && grep -q "./riverrun update genera REDIS_PASSWORD" "$work/out" \
  && grep -q "update no exige firma (UPDATE_ALLOWED_SIGNERS)" "$work/out" && grep -q "«Firma de las actualizaciones»" "$work/out" && grep -q "APROBADO CON ADVERTENCIAS" "$work/out" || { cat "$work/out"; echo "ERROR: Redis sin contraseña y update sin firma debían avisar"; exit 1; }
: > "$work/firmantes"
printf 'REDIS_PASSWORD=x\nUPDATE_ALLOWED_SIGNERS=%s\n' "$work/firmantes" >> .env
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && ! grep -q "Redis sin contraseña" "$work/out" && ! grep -q "update no exige firma" "$work/out" && grep -q "SIN BLOQUEOS EN LO REVISADO" "$work/out" || { cat "$work/out"; echo "ERROR: con contraseña y firmantes no debía avisar"; exit 1; }
mv -f .env.redis .env

echo "== preflight: PANEL_BIND=0.0.0.0 avisa que Docker salta el firewall (INF-10)"
cp .env .env.bind; printf 'PANEL_BIND=0.0.0.0\n' >> .env
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && grep -q "APROBADO CON ADVERTENCIAS" "$work/out" && grep -q "PANEL_BIND=0.0.0.0 publica el puerto 3000" "$work/out" && grep -q "por encima del firewall" "$work/out" || { cat "$work/out"; echo "ERROR: PANEL_BIND abierto debía avisar"; exit 1; }
mv -f .env.bind .env

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

echo "== preflight: si la herramienta de configuración no puede correr, no se afirma que la configuración está revisada"
touch CONFIG_NO_CORRE
set +e; ./riverrun preflight --offline > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" == 0 ]] && grep -q "No verificado: configuración" "$work/out" && ! grep -q "Configuración: sin problemas críticos" "$work/out" || { cat "$work/out"; echo "ERROR: afirmó una configuración que no revisó"; exit 1; }
rm -f CONFIG_NO_CORRE

echo "== observación: un fallo aislado durante la ventana no revierte"
: > "$LOG"; rm -f HEALTH_N; echo 4 > FALLA_TARDIA; newcommit v20
./riverrun update > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: un fallo aislado revirtió la actualización"; exit 1; }
grep -q "Una comprobación falló" "$work/out" && grep -q "se mantuvo sana" "$work/out"
[[ "$(cat VERSION)" == v20 ]]
rm -f FALLA_TARDIA HEALTH_N

echo "== observación: una falla sostenida durante la ventana sí revierte"
: > "$LOG"; rm -f HEALTH_N; echo 4 > FALLA_TARDIA; touch FALLA_SOSTENIDA; newcommit v21
if ./riverrun update > "$work/out" 2>&1; then echo "ERROR: aplicó una versión que falló durante la observación"; exit 1; fi
grep -q "Falla sostenida durante la observación" "$work/out"; [[ "$(cat VERSION)" == v20 ]]
rm -f FALLA_TARDIA FALLA_SOSTENIDA HEALTH_N FALLA_NUEVA

echo "== observación: un valor inválido se rechaza antes de descargar, respaldar o tocar nada"
: > "$LOG"; before="$(cat VERSION)"
set +e; RIVERRUN_OBSERVE_SECONDS=abc ./riverrun update > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "RIVERRUN_OBSERVE_SECONDS" "$work/out" || { cat "$work/out"; echo "ERROR: aceptó un valor inválido"; exit 1; }
! grep -q "backup.sh now\|compose up\|git pull\|up -d" "$LOG" || { echo "ERROR: hizo trabajo antes de validar"; exit 1; }
[[ "$(cat VERSION)" == "$before" ]]

echo "== install sin Docker usa el repositorio apt con la llave de Docker (huella revisada antes de usarla)"
dk="$work/docker-apt"; mkdir -p "$dk/bin" "$dk/etc"
printf 'ID=ubuntu\nVERSION_CODENAME=noble\n' > "$dk/etc/os-release"
APTLOG="$dk/apt.log"; export APTLOG
cat > "$dk/bin/apt-get" <<'SHIM'
#!/usr/bin/env bash
echo "apt-get $*" >> "$APTLOG"
SHIM
cat > "$dk/bin/curl" <<'SHIM'
#!/usr/bin/env bash
echo "curl $*" >> "$APTLOG"
[[ "$*" == *"| sh"* || "$*" == *get.docker.com* ]] && exit 9
out=""; while (( $# )); do [[ "$1" == "-o" ]] && { out="$2"; shift; }; shift; done
[[ -n "$out" ]] && echo "LLAVE-FALSA" > "$out"
SHIM
cat > "$dk/bin/gpg" <<'SHIM'
#!/usr/bin/env bash
echo "gpg $*" >> "$APTLOG"
echo "pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::scESA::::::23::0:"
echo "fpr:::::::::${FAKE_FPR:-9DC858229FC7DD38854AE2D88D81803C0EBFCD88}:"
echo "sub:-:4096:1:7EA0A9C3F273FCD8:1487792064::::::s::::::23:"
echo "fpr:::::::::D3306A018370199E527AE7997EA0A9C3F273FCD8:"
if [[ -n "${FAKE_SECOND_KEY:-}" ]]; then echo "pub:-:4096:1:1111111111111111:1487788586:::-:::scESA::::::23::0:"; echo "fpr:::::::::1111111111111111111111111111111111111111:"; fi
SHIM
cat > "$dk/bin/dpkg" <<'SHIM'
#!/usr/bin/env bash
echo amd64
SHIM
chmod +x "$dk/bin/"*
dkenv=(env PATH="$dk/bin:$PATH" RIVERRUN_TEST=1 RIVERRUN_ETC="$dk/etc")
"${dkenv[@]}" ./riverrun install-docker > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: install-docker falló con la llave correcta"; exit 1; }
grep -q "download.docker.com/linux/ubuntu/gpg" "$APTLOG" || { cat "$APTLOG"; echo "ERROR: no bajó la llave de Docker"; exit 1; }
grep -q "apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin" "$APTLOG" || { cat "$APTLOG"; echo "ERROR: no instaló desde apt"; exit 1; }
! grep -q "get.docker.com" "$APTLOG" || { echo "ERROR: usó get.docker.com"; exit 1; }
grep -q "signed-by=$dk/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" "$dk/etc/apt/sources.list.d/docker.list" || { cat "$dk/etc/apt/sources.list.d/docker.list"; echo "ERROR: repositorio mal escrito"; exit 1; }
[[ "$(cat "$dk/etc/apt/keyrings/docker.asc")" == "LLAVE-FALSA" ]] || { echo "ERROR: no guardó la llave"; exit 1; }
# Una llave con otra huella: no se guarda ni se agrega el repositorio.
rm -rf "$dk/etc/apt"; : > "$APTLOG"
set +e; "${dkenv[@]}" FAKE_FPR=0000000000000000000000000000000000000000 ./riverrun install-docker > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "huella" "$work/out" || { cat "$work/out"; echo "ERROR: aceptó una llave con otra huella"; exit 1; }
[[ ! -e "$dk/etc/apt/keyrings/docker.asc" && ! -e "$dk/etc/apt/sources.list.d/docker.list" ]] || { echo "ERROR: dejó la llave o el repositorio con otra huella"; exit 1; }
! grep -q "docker-ce" "$APTLOG" || { echo "ERROR: instaló con una llave mala"; exit 1; }
# Dos llaves en el archivo (la de Docker y otra): no se acepta aunque la primera sea la buena.
rm -rf "$dk/etc/apt"; : > "$APTLOG"
set +e; "${dkenv[@]}" FAKE_SECOND_KEY=1 ./riverrun install-docker > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 && ! -e "$dk/etc/apt/keyrings/docker.asc" ]] && ! grep -q "docker-ce" "$APTLOG" || { cat "$work/out"; echo "ERROR: aceptó un archivo con dos llaves"; exit 1; }
# Un derivado de Ubuntu (Mint) usa el repositorio de Ubuntu con su UBUNTU_CODENAME; un nombre raro se rechaza.
printf 'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=wilma\nUBUNTU_CODENAME=noble\n' > "$dk/etc/os-release"
"${dkenv[@]}" ./riverrun install-docker > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: Mint debía instalarse"; exit 1; }
grep -q "download.docker.com/linux/ubuntu noble stable" "$dk/etc/apt/sources.list.d/docker.list" || { cat "$dk/etc/apt/sources.list.d/docker.list"; echo "ERROR: Mint debía usar ubuntu noble"; exit 1; }
rm -rf "$dk/etc/apt"
printf 'ID=debian\nVERSION_CODENAME="bookworm main"\n' > "$dk/etc/os-release"
set +e; "${dkenv[@]}" ./riverrun install-docker > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 && ! -e "$dk/etc/apt/sources.list.d/docker.list" ]] || { cat "$work/out"; echo "ERROR: aceptó una versión con espacios"; exit 1; }
# Sin RIVERRUN_TEST=1, RIVERRUN_ETC no se usa y sin root no se instala. Como root se omite: escribiría en el /etc real.
if [[ "$(id -u)" != 0 ]]; then
  set +e; env PATH="$dk/bin:$PATH" RIVERRUN_ETC="$dk/etc" ./riverrun install-docker > "$work/out" 2>&1; rc=$?; set -e
  [[ "$rc" != 0 ]] && grep -q "requiere root" "$work/out" || { cat "$work/out"; echo "ERROR: RIVERRUN_ETC sin RIVERRUN_TEST saltó el root"; exit 1; }
fi
# Un sistema que no es Debian ni Ubuntu: no se adivina, se manda a la guía oficial.
printf 'ID=fedora\nVERSION_CODENAME=\n' > "$dk/etc/os-release"
set +e; "${dkenv[@]}" ./riverrun install-docker > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "docs.docker.com/engine/install" "$work/out" || { cat "$work/out"; echo "ERROR: en otro sistema debía mandar a la guía"; exit 1; }
! grep -q "get.docker.com" "$here/riverrun" || { echo "ERROR: riverrun aún menciona get.docker.com"; exit 1; }

echo "== INF-12: las llaves no se imprimen solas; ./riverrun keys las da solo a una terminal (o con --stdout)"
set +e; ./riverrun keys > "$work/out" 2>&1; rc=$?; set -e
bp="$(sed -n 's/^DATA_KEY=//p' .env | tail -n 1)"
[[ "$rc" != 0 && -n "$bp" ]] && ! grep -qF "$bp" "$work/out" && grep -q "no es una terminal" "$work/out" || { cat "$work/out"; echo "ERROR: keys escribió las llaves fuera de una terminal"; exit 1; }
./riverrun keys --stdout > "$work/out" 2>&1 && grep -qF "  DATA_KEY=$bp" "$work/out" || { cat "$work/out"; echo "ERROR: keys --stdout no mostró las llaves"; exit 1; }
! grep -Eq 'say .*(BACKUP_PASSPHRASE|SESSION_SECRET|DATA_KEY)=\$\(env_get' "$here/riverrun" || { echo "ERROR: el instalador todavía imprime llaves"; exit 1; }
# install --no-start sin terminal: la contraseña generada no sale en la salida.
ins="$work/ins"; mkdir -p "$ins"; cp "$here/riverrun" "$here/.env.example" "$ins/"
(cd "$ins" && RIVERRUN_ADMIN_EMAIL=dueno@ejemplo.mx ./riverrun install --non-interactive --no-start > "$work/out" 2>&1) || { cat "$work/out"; echo "ERROR: install --no-start falló"; exit 1; }
ap="$(sed -n 's/^ADMIN_PASSWORD=//p' "$ins/.env" | tail -n 1)"
[[ -n "$ap" ]] && ! grep -qF "$ap" "$work/out" && grep -q "no se muestra" "$work/out" || { cat "$work/out"; echo "ERROR: install imprimió la contraseña sin terminal"; exit 1; }
! grep -qF "$(sed -n 's/^SESSION_SECRET=//p' "$ins/.env" | tail -n 1)" "$work/out" || { echo "ERROR: install imprimió SESSION_SECRET"; exit 1; }

echo "== harden: actualizaciones, fail2ban, SSH solo con llave y firewall que también cubre a Docker"
hd="$work/harden"; mkdir -p "$hd/bin" "$hd/root/etc/ssh" "$hd/root/etc/ufw" "$hd/root/root/.ssh"
HLOG="$hd/log"; export HLOG; : > "$HLOG"
printf 'ID=debian\nVERSION_CODENAME=bookworm\n' > "$hd/root/etc/os-release"
printf 'Include /etc/ssh/sshd_config.d/*.conf\nPort 2222\n' > "$hd/root/etc/ssh/sshd_config"
printf '*filter\n:ufw-after-input - [0:0]\nCOMMIT\n' > "$hd/root/etc/ufw/after.rules"; cp "$hd/root/etc/ufw/after.rules" "$hd/root/etc/ufw/after6.rules"
for c in apt-get ufw; do printf '#!/usr/bin/env bash\necho "%s $*" >> "$HLOG"\n' "$c" > "$hd/bin/$c"; done
cat > "$hd/bin/systemctl" <<'SHIM'
#!/usr/bin/env bash
echo "systemctl $*" >> "$HLOG"
# Con FAKE_SOCKET, SSH escucha por ssh.socket (Ubuntu 24.04) en un puerto distinto del de sshd_config.
[[ "$1" == "is-active" ]] && { [[ -n "${FAKE_SOCKET:-}" ]]; exit; }
[[ "$1" == "show" ]] && echo "[::]:${FAKE_SOCKET:-22} (Stream)"
exit 0
SHIM
cat > "$hd/bin/sshd" <<'SHIM'
#!/usr/bin/env bash
echo "sshd $*" >> "$HLOG"
[[ "$1" == "-t" && -n "${FAKE_SSHD_BAD:-}" ]] && exit 1
if [[ "$1" == "-T" ]]; then
  [[ -n "${FAKE_NOPORT:-}" ]] && exit 255
  echo "port 2222"; echo "kbdinteractiveauthentication no"
  # Un bloque Match que vuelve a encender las contraseñas solo se ve con -C.
  if [[ "$2" == "-C" && -n "${FAKE_MATCH_PW:-}" ]]; then echo "passwordauthentication yes"; else echo "passwordauthentication ${FAKE_PWAUTH:-no}"; fi
fi
exit 0
SHIM
chmod +x "$hd/bin/"*
hdenv=(env PATH="$hd/bin:$PATH" RIVERRUN_TEST=1 RIVERRUN_ROOT="$hd/root")
cp .env .env.harden; printf 'COMPOSE_PROFILES=https\n' >> .env
# Sin terminal y sin --yes: no hace nada.
set +e; "${hdenv[@]}" ./riverrun harden > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "confirma con --yes" "$work/out" && ! grep -Ev "^systemctl (is-active|show)" "$HLOG" | grep -Eq "^(apt-get|ufw|systemctl)" || { cat "$work/out"; echo "ERROR: harden sin confirmar cambió algo"; exit 1; }
# Sin llave autorizada: SSH se deja como está (no deja a nadie fuera); el resto sí se aplica.
"${hdenv[@]}" ./riverrun harden --yes > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: harden falló"; exit 1; }
[[ ! -e "$hd/root/etc/ssh/sshd_config.d/01-riverrun.conf" ]] && grep -q "te dejaría fuera" "$work/out" || { cat "$work/out"; echo "ERROR: apagó contraseñas sin llave autorizada"; exit 1; }
grep -q 'Unattended-Upgrade "1"' "$hd/root/etc/apt/apt.conf.d/20auto-upgrades" || { echo "ERROR: sin actualizaciones automáticas"; exit 1; }
grep -q "^port = 2222$" "$hd/root/etc/fail2ban/jail.d/riverrun.local" || { echo "ERROR: fail2ban no vigila el puerto real de SSH"; exit 1; }
grep -q "ufw limit 2222/tcp" "$HLOG" && grep -q "ufw allow 80/tcp" "$HLOG" && grep -q "ufw allow 443/tcp" "$HLOG" && grep -q "ufw default deny incoming" "$HLOG" && grep -q "ufw --force enable" "$HLOG" || { cat "$HLOG"; echo "ERROR: firewall incompleto"; exit 1; }
# SSH se permite antes de encender el firewall.
[[ "$(grep -n "ufw limit 2222" "$HLOG" | cut -d: -f1)" -lt "$(grep -n "ufw --force enable" "$HLOG" | cut -d: -f1)" ]] || { echo "ERROR: encendió el firewall antes de permitir SSH"; exit 1; }
grep -q -- "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j RETURN" "$hd/root/etc/ufw/after.rules" && grep -q -- "-A DOCKER-USER -m conntrack --ctstate NEW -j DROP" "$hd/root/etc/ufw/after.rules" && grep -q ":ufw-after-input" "$hd/root/etc/ufw/after.rules" || { cat "$hd/root/etc/ufw/after.rules"; echo "ERROR: DOCKER-USER no cierra lo que publica Docker"; exit 1; }
! grep -q -- "--ctorigdstport 3000" "$hd/root/etc/ufw/after.rules" || { echo "ERROR: abrió el panel hacia afuera"; exit 1; }
grep -q -- "-A DOCKER-USER -i br-+ -j RETURN" "$hd/root/etc/ufw/after6.rules" || { echo "ERROR: falta IPv6"; exit 1; }
! grep -q -- "-s 10.0.0.0/8" "$hd/root/etc/ufw/after.rules" || { echo "ERROR: la red privada del proveedor no debe pasar"; exit 1; }
# Las reglas generadas las acepta iptables de verdad (si se puede probar aquí).
if command -v iptables-restore >/dev/null 2>&1 && [[ "$(id -u)" == 0 ]]; then
  iptables-restore --test -n < "$hd/root/etc/ufw/after.rules" && ip6tables-restore --test -n < "$hd/root/etc/ufw/after6.rules" || { echo "ERROR: iptables rechaza las reglas"; exit 1; }
fi
[[ -f "$hd/root/etc/riverrun-harden" ]] || { echo "ERROR: no dejó su marca"; exit 1; }
# Con llave: SSH solo con llave; repetir no duplica el bloque; un puerto extra se agrega.
# Una llave de otra cuenta no cuenta: quien corre harden (SUDO_USER) entra con la suya.
mkdir -p "$hd/root/home/otra/.ssh" "$hd/root/home/dueno/.ssh"
if command -v ssh-keygen >/dev/null 2>&1; then ssh-keygen -q -t ed25519 -N '' -C dueno@laptop -f "$hd/k"; pub="$(cat "$hd/k.pub")"
else pub="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dueno@laptop"; fi
echo "$pub" > "$hd/root/home/otra/.ssh/authorized_keys"
"${hdenv[@]}" SUDO_USER=dueno ./riverrun harden --yes --skip-firewall > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: harden falló"; exit 1; }
[[ ! -e "$hd/root/etc/ssh/sshd_config.d/01-riverrun.conf" ]] && grep -q "La cuenta dueno no tiene una llave" "$work/out" || { cat "$work/out"; echo "ERROR: usó la llave de otra cuenta"; exit 1; }
echo "from=\"203.0.113.0/24\" $pub" > "$hd/root/root/.ssh/authorized_keys"
: > "$HLOG"
"${hdenv[@]}" HARDEN_ALLOW_PORTS=8443 ./riverrun harden --yes > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: harden con llave falló"; exit 1; }
grep -q "^PasswordAuthentication no$" "$hd/root/etc/ssh/sshd_config.d/01-riverrun.conf" && grep -q "^PermitRootLogin prohibit-password$" "$hd/root/etc/ssh/sshd_config.d/01-riverrun.conf" && grep -q "SSH solo con llave" "$work/out" || { cat "$work/out"; echo "ERROR: SSH no quedó solo con llave"; exit 1; }
! grep -q "MaxAuthTries" "$hd/root/etc/ssh/sshd_config.d/01-riverrun.conf" || { echo "ERROR: MaxAuthTries bajo deja fuera a quien tiene varias llaves"; exit 1; }
grep -q "sshd -t" "$HLOG" && grep -q "systemctl reload ssh" "$HLOG" || { cat "$HLOG"; echo "ERROR: no validó ni recargó SSH"; exit 1; }
[[ "$(grep -c "BEGIN riverrun DOCKER-USER" "$hd/root/etc/ufw/after.rules")" == 1 ]] && grep -q -- "--ctorigdstport 8443" "$hd/root/etc/ufw/after.rules" && grep -q "ufw allow 8443/tcp" "$HLOG" || { cat "$hd/root/etc/ufw/after.rules"; echo "ERROR: el bloque se duplicó o falta el puerto extra"; exit 1; }
# Un Match que vuelve a encender las contraseñas (solo visible con sshd -T -C): se avisa.
"${hdenv[@]}" FAKE_MATCH_PW=1 ./riverrun harden --yes --skip-firewall > "$work/out" 2>&1 && grep -q "sigue aceptando contraseñas" "$work/out" || { cat "$work/out"; echo "ERROR: no vio el Match con contraseñas"; exit 1; }
# ssh.socket escucha en 22 aunque sshd_config diga 2222, y esta sesión llega por el 22: se permiten los dos, y la IP de
# esta sesión nunca la bloquea fail2ban.
: > "$HLOG"
"${hdenv[@]}" FAKE_SOCKET=22 SSH_CONNECTION="198.51.100.7 50000 10.0.0.5 22" ./riverrun harden --yes > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: harden con ssh.socket falló"; exit 1; }
grep -q "ufw limit 22/tcp" "$HLOG" && grep -q "ufw limit 2222/tcp" "$HLOG" || { cat "$HLOG"; echo "ERROR: no permitió el puerto real de SSH"; exit 1; }
grep -q "^ignoreip = 127.0.0.1/8 ::1 198.51.100.7$" "$hd/root/etc/fail2ban/jail.d/riverrun.local" && grep -q "^port = 22,2222$" "$hd/root/etc/fail2ban/jail.d/riverrun.local" || { cat "$hd/root/etc/fail2ban/jail.d/riverrun.local"; echo "ERROR: fail2ban sin la IP propia o sin los puertos"; exit 1; }
# Sin saber el puerto de SSH, no se toca nada.
: > "$HLOG"
set +e; "${hdenv[@]}" FAKE_NOPORT=1 ./riverrun harden --yes > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "en qué puerto escucha SSH" "$work/out" && ! grep -q "^ufw" "$HLOG" || { cat "$work/out"; echo "ERROR: adivinó el puerto de SSH"; exit 1; }
# Un bloque a medias en after.rules: no se borra el resto del archivo.
cp "$hd/root/etc/ufw/after.rules" "$hd/after.ok"; printf '%s\n' "# BEGIN riverrun DOCKER-USER (./riverrun harden)" "-A x" "*nat" "COMMIT" > "$hd/root/etc/ufw/after.rules"
set +e; "${hdenv[@]}" ./riverrun harden --yes > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "bloque de riverrun incompleto" "$work/out" && grep -q "^\*nat$" "$hd/root/etc/ufw/after.rules" || { cat "$work/out"; echo "ERROR: un bloque a medias borró el archivo"; exit 1; }
cp "$hd/after.ok" "$hd/root/etc/ufw/after.rules"
# Otro archivo vuelve a encender las contraseñas: se avisa, no se afirma.
"${hdenv[@]}" FAKE_PWAUTH=yes ./riverrun harden --yes --skip-firewall > "$work/out" 2>&1 && grep -q "sigue aceptando contraseñas" "$work/out" || { cat "$work/out"; echo "ERROR: debía avisar que SSH sigue con contraseñas"; exit 1; }
# Una configuración que sshd rechaza: se quita y no se recarga.
: > "$HLOG"
set +e; "${hdenv[@]}" FAKE_SSHD_BAD=1 ./riverrun harden --yes --skip-firewall > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 && ! -e "$hd/root/etc/ssh/sshd_config.d/01-riverrun.conf" ]] && ! grep -q "reload ssh" "$HLOG" || { cat "$work/out"; echo "ERROR: dejó una configuración de SSH inválida"; exit 1; }
# Puerto inválido y otro sistema: no se toca nada.
set +e; "${hdenv[@]}" HARDEN_ALLOW_PORTS="80;rm" ./riverrun harden --yes > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "no es un puerto" "$work/out" || { cat "$work/out"; echo "ERROR: aceptó un puerto inválido"; exit 1; }
printf 'ID=arch\n' > "$hd/root/etc/os-release"
set +e; "${hdenv[@]}" ./riverrun harden --yes > "$work/out" 2>&1; rc=$?; set -e
[[ "$rc" != 0 ]] && grep -q "endurece este servidor a mano" "$work/out" || { cat "$work/out"; echo "ERROR: harden en otro sistema"; exit 1; }
# Familia Red Hat (AlmaLinux): dnf-automatic solo seguridad, EPEL para fail2ban, firewalld con DOCKER-USER, nada de ufw.
printf 'ID="almalinux"\nID_LIKE="rhel centos fedora"\n' > "$hd/root/etc/os-release"
for c in dnf firewall-cmd; do printf '#!/usr/bin/env bash\necho "%s $*" >> "$HLOG"\n' "$c" > "$hd/bin/$c"; done; chmod +x "$hd/bin/"*
mkdir -p "$hd/root/etc/dnf"; printf '[commands]\nupgrade_type = default\napply_updates = no\n' > "$hd/root/etc/dnf/automatic.conf"
: > "$HLOG"
"${hdenv[@]}" ./riverrun harden --yes > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: harden en AlmaLinux falló"; exit 1; }
grep -q "^dnf install -y -q epel-release" "$HLOG" && grep -q "^dnf install -y -q dnf-automatic fail2ban python3-systemd firewalld" "$HLOG" || { cat "$HLOG"; echo "ERROR: paquetes de la familia Red Hat"; exit 1; }
grep -q "^upgrade_type = security$" "$hd/root/etc/dnf/automatic.conf" && grep -q "^apply_updates = yes$" "$hd/root/etc/dnf/automatic.conf" || { cat "$hd/root/etc/dnf/automatic.conf"; echo "ERROR: dnf-automatic no quedó en seguridad"; exit 1; }
grep -q "systemctl enable --now dnf-automatic.timer" "$HLOG" && grep -q "systemctl enable --now firewalld" "$HLOG" || { cat "$HLOG"; echo "ERROR: no encendió dnf-automatic o firewalld"; exit 1; }
grep -q "firewall-cmd --permanent --add-port=2222/tcp" "$HLOG" && grep -q "firewall-cmd --permanent --add-port=443/tcp" "$HLOG" && grep -q "firewall-cmd --permanent --add-port=443/udp" "$HLOG" || { cat "$HLOG"; echo "ERROR: puertos de firewalld"; exit 1; }
grep -q -- "--direct --add-rule ipv4 filter DOCKER-USER [0-9]* -m conntrack --ctstate NEW -j DROP" "$HLOG" && grep -q -- "--direct --add-rule ipv6 filter DOCKER-USER 0 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" "$HLOG" && grep -q -- "--direct --remove-rules ipv4 filter DOCKER-USER" "$HLOG" || { cat "$HLOG"; echo "ERROR: DOCKER-USER en firewalld"; exit 1; }
[[ "$(grep -n -- "--add-port=2222/tcp" "$HLOG" | head -1 | cut -d: -f1)" -lt "$(grep -n "firewall-cmd --reload" "$HLOG" | cut -d: -f1)" ]] || { echo "ERROR: recargó firewalld antes de permitir SSH"; exit 1; }
! grep -q "^ufw\|^apt-get" "$HLOG" || { cat "$HLOG"; echo "ERROR: usó ufw o apt en AlmaLinux"; exit 1; }
# Fedora: sin EPEL.
printf 'ID=fedora\n' > "$hd/root/etc/os-release"; : > "$HLOG"
"${hdenv[@]}" ./riverrun harden --yes --skip-firewall > "$work/out" 2>&1 || { cat "$work/out"; echo "ERROR: harden en Fedora falló"; exit 1; }
! grep -q "epel-release" "$HLOG" && grep -q "^dnf install -y -q dnf-automatic fail2ban python3-systemd$" "$HLOG" || { cat "$HLOG"; echo "ERROR: Fedora no usa EPEL"; exit 1; }
if [[ "$(id -u)" != 0 ]]; then
  set +e; env PATH="$hd/bin:$PATH" RIVERRUN_ROOT="$hd/root" ./riverrun harden --yes > "$work/out" 2>&1; rc=$?; set -e
  [[ "$rc" != 0 ]] && grep -q "requiere root" "$work/out" || { cat "$work/out"; echo "ERROR: RIVERRUN_ROOT sin RIVERRUN_TEST saltó el root"; exit 1; }
fi
mv .env.harden .env
./riverrun help | grep -q "harden" || { echo "ERROR: la ayuda no menciona harden"; exit 1; }

echo "OK: el flujo de actualización funciona"
