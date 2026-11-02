#!/usr/bin/env bash
# Respaldos de Riverrun: bases de datos (chatbot y Evolution), fotos subidas y sesiones de WhatsApp (con sus claves en Redis).
#
#   backup.sh daemon        un respaldo cada día a BACKUP_HOUR (UTC) — es lo que corre el contenedor "backup"
#   backup.sh now           respaldo inmediato
#   backup.sh verify [FILE] comprueba que el respaldo (el último por defecto) se puede restaurar
#   backup.sh restore FILE  restaura (FILE o "latest"); con el sistema detenido salvo PostgreSQL
#   backup.sh list          lista los respaldos
#   backup.sh evolution-cleanup  borra en Evolution lo pedido por el backend y lo más viejo que EVOLUTION_MESSAGE_DAYS
#
# Cada respaldo es un solo archivo .gpg.tar: cada parte (las bases, las fotos, las sesiones, las claves de Redis) va
# cifrada por separado con BACKUP_PASSPHRASE (gpg, AES-256 con verificación de integridad: un archivo alterado no se
# abre) desde que se escribe, así que nunca queda en claro en el disco. Sin la clave no se puede leer: guárdala fuera
# del servidor (gestor de contraseñas). Los respaldos de antes (.tar.enc, openssl sin autenticación) se siguen abriendo.
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-/data/uploads}"
EVOLUTION_DIR="${EVOLUTION_DIR:-/evolution/instances}"
BACKUP_HOUR="${BACKUP_HOUR:-03:30}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
REMOTE="${BACKUP_REMOTE:-}"
REMOTE_KEEP_DAYS="${BACKUP_REMOTE_KEEP_DAYS:-45}"
DATABASES="${BACKUP_DATABASES:-chatbot evolution}"
EVOLUTION_DB="${BACKUP_EVOLUTION_DB:-evolution}" # base de Evolution dentro de DATABASES (sesiones de WhatsApp)
# Redis de Evolution: con su caché en Redis, Evolution guarda ahí las claves de cifrado de cada sesión de WhatsApp (en
# su base solo queda la credencial). Sin ellas, una sesión restaurada no descifra los mensajes y hay que volver a vincular.
REDIS_URI="${BACKUP_REDIS_URI:-}"
REDIS_DIR="${REDIS_DATA_DIR:-/redis}" # volumen de Redis (solo al restaurar: ahí se deja la copia para cargarla)
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-chatbot}" PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
STATUS="$BACKUP_DIR/status.json"
APP_DB="${BACKUP_APP_DB:-chatbot}" # base del backend (ahí deja el backend los borrados pendientes para Evolution)
# INF-8: días que Evolution conserva cada mensaje (el backend ya descargó notas de voz y archivos al llegar). 0 = sin límite.
EVOLUTION_MESSAGE_DAYS="${EVOLUTION_MESSAGE_DAYS:-7}"

# Copia en la nube con variables sencillas (cualquier almacenamiento compatible con S3: Backblaze B2, Cloudflare R2, AWS, Wasabi…).
if [[ -z "$REMOTE" && -n "${BACKUP_S3_BUCKET:-}" ]]; then
  export RCLONE_CONFIG_BK_TYPE=s3
  export RCLONE_CONFIG_BK_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_BK_ACCESS_KEY_ID="${BACKUP_S3_KEY:-}"
  export RCLONE_CONFIG_BK_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET:-}"
  export RCLONE_CONFIG_BK_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
  export RCLONE_CONFIG_BK_REGION="${BACKUP_S3_REGION:-}"
  export RCLONE_CONFIG_BK_ACL=private
  REMOTE="bk:${BACKUP_S3_BUCKET}/riverrun"
fi

log() { echo "[$(date -u +%FT%TZ)] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
fail() { log "ERROR: $*"; return 1; } # para funciones que el llamador evalúa (no termina el programa)
TMP_DIRS=()
cleanup() { for d in "${TMP_DIRS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done; dropdb --if-exists riverrun_verify >/dev/null 2>&1 || true; }
trap cleanup EXIT
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

write_status() { # ok file size verified remote_ok error
  mkdir -p "$BACKUP_DIR"
  local now; now="$(date -u +%FT%TZ)"
  local last_ok=""
  if [[ "$1" == "true" ]]; then last_ok="$now"; else last_ok="$(sed -n 's/.*"last_success_at": *"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null || true)"; fi
  cat > "$STATUS.tmp" <<JSON
{"ok": $1, "last_attempt_at": "$now", "last_success_at": "$last_ok", "file": "$(json_escape "$2")", "size_bytes": ${3:-0}, "verified": ${4:-false}, "remote": "$(json_escape "$REMOTE")", "remote_ok": ${5:-null}, "error": "$(json_escape "${6:-}")"}
JSON
  mv "$STATUS.tmp" "$STATUS"
}

need_passphrase() {
  if [[ -z "${BACKUP_PASSPHRASE:-}" && "${BACKUP_ALLOW_PLAINTEXT:-false}" != "true" ]]; then
    die "Falta BACKUP_PASSPHRASE: los respaldos contienen conversaciones y claves, así que se cifran. Defínela en .env."
  fi
}

# INF-11: cifrado autenticado (gpg simétrico, AES-256 con MDC: si alguien cambia un byte, no descifra). La clave va por
# un descriptor, nunca en los argumentos.
export GNUPGHOME="${GNUPGHOME:-${TMPDIR:-/tmp}/riverrun-gnupg}"
mkdir -p -m 700 "$GNUPGHOME"
gpg_enc() { gpg --batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
  --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none --output - 3< <(printf '%s' "$BACKUP_PASSPHRASE"); }
gpg_dec() { gpg --batch --quiet --no-tty --pinentry-mode loopback --passphrase-fd 3 --decrypt --output - "$1" 3< <(printf '%s' "$BACKUP_PASSPHRASE") 2>/dev/null; }
seal() { if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then gpg_enc; else cat; fi; }
SEAL_EXT=""; [[ -n "${BACKUP_PASSPHRASE:-}" ]] && SEAL_EXT=".gpg"
# Respaldos de antes: un solo archivo .tar.enc (openssl, sin autenticación).
decrypt_legacy() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE < "$1"; }

# Abre un respaldo en DIR: los nuevos solo se desempacan (sus partes siguen cifradas); los de antes se descifran enteros.
open_backup() { # FILE DIR
  if [[ "$1" == *.tar.enc ]]; then decrypt_legacy "$1" | tar -C "$2" -xf - 2>/dev/null; return; fi
  tar -C "$2" -xf "$1" 2>/dev/null || return 1
  # Formato nuevo: solo partes cifradas y las sumas, con su copia cifrada idéntica. Así nadie con acceso al volumen o al
  # bucket arma un respaldo con partes en claro, ni mezcla partes de respaldos distintos. (En claro solo con
  # BACKUP_ALLOW_PLAINTEXT=true, que es para pruebas.)
  [[ "${BACKUP_ALLOW_PLAINTEXT:-false}" == "true" && ! -f "$2/SHA256SUMS.gpg" ]] && return 0
  local f
  for f in "$2"/* "$2"/.[!.]*; do
    [[ -e "$f" ]] || continue
    case "$(basename "$f")" in
      manifest.json|SHA256SUMS|SHA256SUMS.gpg|*.dump.gpg|uploads.tar.gz.gpg|evolution_instances.tar.gz.gpg|redis.rdb.gpg) ;;
      *) log "ERROR: el respaldo trae una parte sin cifrar o desconocida: $(basename "$f")"; return 1 ;;
    esac
  done
  [[ -f "$2/SHA256SUMS.gpg" ]] || { log "ERROR: al respaldo le faltan sus sumas cifradas"; return 1; }
  gpg_dec "$2/SHA256SUMS.gpg" | cmp -s - "$2/SHA256SUMS" || { log "ERROR: las sumas del respaldo no coinciden con su copia cifrada (¿clave incorrecta o partes cambiadas?)"; return 1; }
}
has_part() { [[ -f "$1/$2.gpg" || -f "$1/$2" ]]; } # DIR NAME
part() { # DIR NAME → la parte en claro por la salida (descifra si va cifrada; falla si fue alterada)
  if [[ -f "$1/$2.gpg" ]]; then gpg_dec "$1/$2.gpg"; elif [[ -f "$1/$2" ]]; then cat "$1/$2"; else return 1; fi
}
# Lee la parte entera aunque el lector se detenga antes (así gpg comprueba la integridad y no muere por SIGPIPE).
drain_into() { local s; "$@"; s=$?; cat >/dev/null; return "$s"; }

wait_for_db() {
  for _ in $(seq 1 30); do pg_isready -q && return 0; sleep 2; done
  die "PostgreSQL no responde en $PGHOST"
}

# Última migración de Evolution aplicada en una base (vacío si no existe o no es de Evolution).
evolution_migration() { psql -At -d "$1" -c "SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" 2>/dev/null || true; }
image_digest() { if [[ "$1" == *@sha256:* ]]; then echo "${1##*@}"; else echo "$1"; fi; } # misma imagen escrita de dos formas
manifest_field() { sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n 1; }

latest_file() { { printf '%s\n' "$BACKUP_DIR"/riverrun-*.tar "$BACKUP_DIR"/riverrun-*.tar.enc | grep -v '[*]' || true; } | sort | tail -n 1; }

make_backup() {
  need_passphrase
  umask 077
  mkdir -p "$BACKUP_DIR"
  find "${BACKUP_DIR:?}" -maxdepth 1 -name '*.partial' -delete # restos de un respaldo interrumpido
  wait_for_db
  local ts work out
  ts="$(date -u +%Y%m%d-%H%M%S)"
  work="${BACKUP_DIR:?}/.work"
  rm -rf "${BACKUP_DIR:?}/.work"; mkdir -p -m 700 "$work" # (un intento anterior interrumpido deja restos aquí)
  # Cada parte se cifra mientras se escribe: en el disco nunca queda en claro (INF-11).
  log "Respaldo $ts: bases de datos"
  for db in $DATABASES; do
    pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$db" | seal > "$work/$db.dump$SEAL_EXT"
  done
  log "Respaldo $ts: archivos"
  local src name
  for name in uploads evolution_instances; do
    src="$UPLOADS_DIR"; [[ "$name" == evolution_instances ]] && src="$EVOLUTION_DIR"
    if [[ -d "$src" ]]; then tar -C "$src" -czf - . ; else tar -czf - -T /dev/null; fi | seal > "$work/$name.tar.gz$SEAL_EXT"
  done
  # Claves de las sesiones (instantánea consistente de Redis). Si Redis no responde, el respaldo sigue (las bases y los
  # archivos valen igual) pero queda marcado: la verificación lo da por fallido para que se vea y se avise.
  local redis_keys=""
  if [[ -n "$REDIS_URI" ]]; then
    log "Respaldo $ts: claves de las sesiones de WhatsApp (Redis)"
    if redis-cli -u "$REDIS_URI" --rdb - 2>/dev/null | seal > "$work/redis.rdb$SEAL_EXT" \
      && [[ "$(part "$work" redis.rdb | drain_into head -c 5)" == "REDIS" ]]; then redis_keys=included
    else rm -f "$work/redis.rdb$SEAL_EXT"; redis_keys=missing; log "ATENCIÓN: no se pudo copiar Redis: este respaldo no incluye las claves de las sesiones de WhatsApp"; fi
  fi
  ( cd "$work" && sha256sum ./* > SHA256SUMS )
  # Copia cifrada de las sumas: liga las partes a este respaldo (no se pueden cambiar ni mezclar sin la clave).
  if [[ -n "$SEAL_EXT" ]]; then seal < "$work/SHA256SUMS" > "$work/SHA256SUMS.gpg"; fi
  # Con qué Evolution se hizo: restaurar su base en una versión más vieja que la que la migró puede dañarla.
  local evo_mig=""
  [[ " $DATABASES " == *" $EVOLUTION_DB "* ]] && evo_mig="$(evolution_migration "$EVOLUTION_DB")"
  echo "{\"format\": \"2\", \"encryption\": \"${SEAL_EXT:+gpg}\", \"created_at\": \"$(date -u +%FT%TZ)\", \"databases\": \"$DATABASES\", \"version\": \"${APP_VERSION:-unknown}\", \"evolution_image\": \"$(json_escape "${EVOLUTION_IMAGE:-}")\", \"evolution_migration\": \"$(json_escape "$evo_mig")\", \"redis_keys\": \"$redis_keys\"}" > "$work/manifest.json"
  local suffix="gpg.tar"; [[ -z "$SEAL_EXT" ]] && suffix="tar"
  out="$BACKUP_DIR/${BACKUP_PREFIX:-riverrun}-$ts.$suffix" # el respaldo previo a restaurar usa otro prefijo para que "latest" no lo elija
  tar -C "$work" -cf "$out.partial" .
  mv "$out.partial" "$out"
  rm -rf "${BACKUP_DIR:?}/.work"
  chmod 600 "$out"
  log "Respaldo creado: $(basename "$out") ($(du -h "$out" | cut -f1))"
  echo "$out"
}

verify_backup() { # FILE → descifra cada parte (en memoria: comprueba que nadie la alteró), restaura en una base temporal y cuenta tablas
  local file="${1:-$(latest_file)}"
  [[ -f "$file" ]] || { fail "No hay respaldos que verificar"; return 1; }
  need_passphrase
  wait_for_db
  local work; work="$(mktemp -d "$BACKUP_DIR/.verify.XXXXXX")"; TMP_DIRS+=("$work")
  open_backup "$file" "$work" || { fail "No se pudo abrir $(basename "$file") (¿clave incorrecta o archivo dañado?)"; return 1; }
  ( cd "$work" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) || { fail "Las sumas de verificación no coinciden: respaldo dañado"; return 1; }
  local f
  for f in "$work"/*.gpg; do
    [[ -f "$f" ]] || continue
    gpg_dec "$f" > /dev/null || { fail "No se pudo descifrar $(basename "$f" .gpg) (¿clave incorrecta o archivo alterado?)"; return 1; }
  done
  for f in uploads.tar.gz evolution_instances.tar.gz; do
    has_part "$work" "$f" || continue
    [[ ! -f "$work/$f" || -s "$work/$f" ]] || continue # de antes: vacío si no había archivos
    part "$work" "$f" | drain_into tar -tzf - >/dev/null 2>&1 || { fail "$f dañado"; return 1; }
  done
  # Redis: la instantánea empieza con "REDIS" + versión del formato (se carga con el propio Redis al restaurar).
  if has_part "$work" redis.rdb; then
    [[ "$(part "$work" redis.rdb | drain_into head -c 5)" == "REDIS" ]] || { fail "redis.rdb dañado (claves de las sesiones de WhatsApp)"; return 1; }
  elif [[ "$(manifest_field "$work/manifest.json" redis_keys)" == "missing" ]]; then
    fail "El respaldo no incluye las claves de las sesiones de WhatsApp: Redis no respondió al respaldar"; return 1
  fi
  local dump db
  for dump in "$work"/*.dump "$work"/*.dump.gpg; do
    [[ -f "$dump" ]] || continue
    db="$(basename "$dump")"; db="${db%.gpg}"; db="${db%.dump}"
    part "$work" "$db.dump" | drain_into pg_restore --list >/dev/null 2>&1 || { fail "$db.dump no es legible"; return 1; }
  done
  # Prueba real: restaurar la base principal en una base temporal. Con BACKUP_VERIFY_ALL=true (antes de cambiar la
  # versión de Evolution), todas: también la de Evolution, que guarda las sesiones de WhatsApp.
  local main="${DATABASES%% *}" targets tables total=""
  targets="$main"; [[ "${BACKUP_VERIFY_ALL:-false}" == "true" ]] && targets="$DATABASES"
  for db in $targets; do
    has_part "$work" "$db.dump" || { fail "Falta la base $db en el respaldo"; return 1; }
    dropdb --if-exists riverrun_verify >/dev/null 2>&1 || true
    createdb riverrun_verify
    part "$work" "$db.dump" | drain_into pg_restore --no-owner --exit-on-error --dbname=riverrun_verify >/dev/null 2>&1 || { fail "No se pudo restaurar la base $db en una base de prueba"; return 1; }
    tables="$(psql -At -d riverrun_verify -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
    dropdb --if-exists riverrun_verify >/dev/null 2>&1 || true
    [[ "${tables:-0}" -gt 0 ]] || { fail "La base $db restaurada está vacía"; return 1; }
    total="${total:+$total, }$db: $tables tablas"
  done
  log "Verificado: $(basename "$file") — restauración de prueba correcta ($total)"
}

weekly_key() { date -u -d "${1:0:4}-${1:4:2}-${1:6:2}" +%G-%V; }
monthly_key() { echo "${1:0:6}"; }

prune_local() {
  local files=() keep=() f
  mapfile -t files < <(ls -1 "$BACKUP_DIR"/riverrun-*.tar* 2>/dev/null | sort -r)
  declare -A day week month
  local nd=0 nw=0 nm=0
  for f in "${files[@]}"; do # del más nuevo al más viejo; se conserva el más reciente de cada día / semana / mes
    local d; d="$(basename "$f" | sed -E 's/^riverrun-([0-9]{8})-.*/\1/')"
    local w m; w="$(weekly_key "$d")"; m="$(monthly_key "$d")"
    if [[ -z "${day[$d]:-}" && $nd -lt $KEEP_DAILY ]]; then day[$d]=1; nd=$((nd+1)); keep+=("$f"); continue; fi
    if [[ -z "${week[$w]:-}" && $nw -lt $KEEP_WEEKLY ]]; then week[$w]=1; nw=$((nw+1)); keep+=("$f"); continue; fi
    if [[ -z "${month[$m]:-}" && $nm -lt $KEEP_MONTHLY ]]; then month[$m]=1; nm=$((nm+1)); keep+=("$f"); fi
  done
  for f in "${files[@]}"; do
    if [[ ! " ${keep[*]} " == *" $f "* ]]; then rm -f "$f"; log "Eliminado por antigüedad: $(basename "$f")"; fi
  done
}

# INF-11: la copia en la nube solo escribe. Con una llave que solo puede subir (sin listar ni borrar), alguien que entre
# al servidor no puede borrar ni reescribir las copias de afuera: la limpieza la hace una regla de ciclo de vida del
# bucket (BACKUP_REMOTE_KEEP_DAYS como referencia). BACKUP_REMOTE_PRUNE=true vuelve a borrar desde aquí (necesita una
# llave que pueda borrar, que es justo lo que conviene evitar).
push_remote() { # FILE → nube (rclone). Devuelve 0 si salió bien o no hay nube configurada.
  [[ -n "$REMOTE" ]] || return 0
  rclone copyto "$1" "$REMOTE/$(basename "$1")" --s3-no-check-bucket --no-check-dest --retries 3 --low-level-retries 5 2>&1 | tail -n 3 || return 1
  if [[ "${BACKUP_REMOTE_PRUNE:-false}" == "true" ]]; then
    rclone delete "$REMOTE" --min-age "${REMOTE_KEEP_DAYS}d" --include 'riverrun-*.tar*' >/dev/null 2>&1 || true
  fi
  log "Copia en la nube: $REMOTE/$(basename "$1")"
}

run_now() {
  local file="" err="" verified=false remote_ok=null
  if ! file="$(make_backup)"; then write_status false "" 0 false null "No se pudo crear el respaldo"; log "Falló el respaldo"; return 1; fi
  if verify_backup "$file"; then verified=true; else err="El respaldo se creó pero no pasó la verificación"; fi
  if [[ -n "$REMOTE" ]]; then if push_remote "$file"; then remote_ok=true; else remote_ok=false; err="${err:+$err; }No se pudo copiar a la nube"; fi; fi
  prune_local
  local size; size="$(stat -c %s "$file")"
  if [[ -z "$err" ]]; then write_status true "$(basename "$file")" "$size" true "$remote_ok" ""; log "Respaldo completo."
  else write_status false "$(basename "$file")" "$size" "$verified" "$remote_ok" "$err"; log "$err"; return 1; fi
}

restore() {
  local file="${1:-}"
  [[ -n "$file" ]] || die "Indica el archivo o 'latest'"
  if [[ "$file" == "latest" ]]; then file="$(latest_file)"; elif [[ ! -f "$file" && -f "$BACKUP_DIR/$file" ]]; then file="$BACKUP_DIR/$file"; fi
  [[ -f "$file" ]] || die "No existe el respaldo: $file"
  need_passphrase
  wait_for_db
  umask 077
  local work; work="$(mktemp -d "${TMPDIR:-/tmp}/restore.XXXXXX")"; TMP_DIRS+=("$work")
  log "Abriendo $(basename "$file")"
  open_backup "$file" "$work" || die "No se pudo abrir el respaldo (¿clave incorrecta o respaldo alterado?). No se cambió nada."
  ( cd "$work" && sha256sum -c SHA256SUMS >/dev/null ) || die "Respaldo dañado (las sumas no coinciden)"
  # Todo se descifra (y se comprueba su integridad) ANTES de borrar nada, sin escribirlo: un respaldo alterado no se aplica.
  local enc
  for enc in "$work"/*.gpg; do
    [[ -f "$enc" ]] || continue
    gpg_dec "$enc" > /dev/null || die "No se pudo descifrar $(basename "${enc%.gpg}"): clave incorrecta o respaldo alterado. No se cambió nada."
  done
  local dumps=() d
  for d in "$work"/*.dump "$work"/*.dump.gpg; do [[ -f "$d" ]] || continue; d="$(basename "$d")"; d="${d%.gpg}"; dumps+=("${d%.dump}"); done
  (( ${#dumps[@]} )) || die "El respaldo no trae ninguna base de datos. No se cambió nada."
  for d in "${dumps[@]}"; do part "$work" "$d.dump" | drain_into pg_restore --list >/dev/null 2>&1 || die "La base $d del respaldo no es legible. No se cambió nada."; done
  local b_img b_mig
  b_img="$(manifest_field "$work/manifest.json" evolution_image)"; b_mig="$(manifest_field "$work/manifest.json" evolution_migration)"
  log "Respaldo del $(manifest_field "$work/manifest.json" created_at) (RiverRun $(manifest_field "$work/manifest.json" version); Evolution ${b_img:-no registrada}${b_mig:+, esquema $b_mig})"
  if [[ -n "$b_img" && -n "${EVOLUTION_IMAGE:-}" && "$(image_digest "$b_img")" != "$(image_digest "$EVOLUTION_IMAGE")" ]]; then
    log "ATENCIÓN: el respaldo es de Evolution $b_img y la instalación usa $EVOLUTION_IMAGE."
    log "  Si la configurada es más vieja, fija EVOLUTION_IMAGE=$b_img en .env antes de arrancar (una versión vieja no entiende un esquema más nuevo)."
  fi
  for d in "${dumps[@]}"; do
    log "Restaurando base de datos: $d"
    dropdb --if-exists --force "$d"
    createdb "$d"
    part "$work" "$d.dump" | pg_restore --no-owner --exit-on-error --dbname="$d" || die "Falló la restauración de $d"
  done
  local name dir label
  for name in uploads evolution_instances; do
    dir="$UPLOADS_DIR"; label="fotos y archivos"; [[ "$name" == evolution_instances ]] && { dir="$EVOLUTION_DIR"; label="sesiones de WhatsApp"; }
    has_part "$work" "$name.tar.gz" && [[ -d "$dir" ]] || continue
    [[ ! -f "$work/$name.tar.gz" || -s "$work/$name.tar.gz" ]] || continue # de antes: vacío si no había archivos
    log "Restaurando $label"
    find "$dir" -mindepth 1 -delete
    part "$work" "$name.tar.gz" | tar -C "$dir" -xzf - || die "Falló la restauración de $label"
  done
  # Redis no se puede escribir en caliente desde aquí: se deja la copia en su volumen y `./riverrun restore` la carga con
  # el propio Redis (docker/backup/redis-load.sh) antes de arrancar Evolution.
  if has_part "$work" redis.rdb && [[ -d "$REDIS_DIR" ]]; then
    log "Preparando las claves de las sesiones de WhatsApp (Redis)"
    part "$work" redis.rdb > "$REDIS_DIR/riverrun-restore.rdb"
  elif has_part "$work" redis.rdb; then
    log "ATENCIÓN: el respaldo trae las claves de las sesiones (redis.rdb) pero el volumen de Redis no está en $REDIS_DIR: usa ./riverrun restore."
  elif [[ -d "$REDIS_DIR" ]]; then
    log "ATENCIÓN: este respaldo es anterior y no trae las claves de las sesiones (Redis): si algún WhatsApp no recibe mensajes, vincúlalo de nuevo."
  fi
  log "Restauración completa."
}

# INF-8: Evolution guarda cada mensaje de WhatsApp en su base. Aquí (superusuario; el backend ya no entra a esa base) se
# borran los chats de los contactos que se borraron en el panel y los mensajes más viejos que EVOLUTION_MESSAGE_DAYS.
# Cada solicitud queda hecha y sin sus identificadores. Si Evolution no tiene esas tablas (otra versión), no hace nada.
evolution_cleanup() {
  # Sin PostgreSQL (se está reiniciando): se reintenta en la próxima vuelta, sin tumbar el demonio de respaldos.
  pg_isready -q || { log "Limpieza de Evolution: PostgreSQL no responde; se reintenta en una hora."; return 1; }
  # Ninguna consulta bloquea la vuelta: con filas tomadas por Evolution, se sigue en la próxima.
  local PGOPTIONS="-c statement_timeout=120000 -c lock_timeout=10000"; export PGOPTIONS
  local has; has="$(psql -X -At -d "$EVOLUTION_DB" -c "SELECT to_regclass('public.\"Message\"') IS NOT NULL AND to_regclass('public.\"Instance\"') IS NOT NULL" 2>/dev/null || echo f)"
  [[ "$has" == t ]] || { log "Limpieza de Evolution: su base no tiene las tablas esperadas; no se borra nada."; return 0; }
  local extra=() t
  for t in Chat Contact; do
    [[ "$(psql -X -At -d "$EVOLUTION_DB" -c "SELECT to_regclass('public.\"$t\"') IS NOT NULL" 2>/dev/null)" == t ]] && extra+=("$t")
  done
  local id instance jids n total=0
  # Separadas por tabulador (los nombres de instancia solo llevan letras, números, guion y guion bajo).
  while IFS=$'\t' read -r id instance jids; do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    n="$(psql -X -At -v ON_ERROR_STOP=1 -d "$EVOLUTION_DB" -v inst="$instance" -v jids="$jids" <<'SQL'
WITH gone AS (
  DELETE FROM "Message" m USING "Instance" i
   WHERE m."instanceId" = i.id AND i.name = :'inst'
     AND (m.key->>'remoteJid' = ANY(:'jids'::text[]) OR m.key->>'remoteJidAlt' = ANY(:'jids'::text[]))
  RETURNING 1)
SELECT count(*) FROM gone;
SQL
)" || { log "Limpieza de Evolution: falló el borrado pedido $id; se reintenta en la próxima vuelta."; continue; }
    # Lo que Evolution guarda de ese chat además de sus mensajes (nombre, foto): chats y contactos, si los tiene.
    for t in "${extra[@]}"; do
      psql -X -q -v ON_ERROR_STOP=1 -d "$EVOLUTION_DB" -v inst="$instance" -v jids="$jids" -v tbl="$t" >/dev/null <<'SQL' || { log "Limpieza de Evolution: falló el borrado en $t del pedido $id; se reintenta."; continue 2; }
DELETE FROM :"tbl" x USING "Instance" i WHERE x."instanceId" = i.id AND i.name = :'inst' AND x."remoteJid" = ANY(:'jids'::text[]);
SQL
    done
    psql -X -q -v ON_ERROR_STOP=1 -d "$APP_DB" -c "UPDATE evolution_erasures SET done_at = now(), deleted = ${n:-0}, jids = '{}' WHERE id = $id" >/dev/null
    total=$((total + ${n:-0}))
  done < <(psql -X -At -F $'\t' -d "$APP_DB" -c "SELECT id, instance, jids::text FROM evolution_erasures WHERE done_at IS NULL ORDER BY id LIMIT 500" 2>/dev/null || true)
  (( total > 0 )) && log "Limpieza de Evolution: $total mensajes de contactos borrados."
  if [[ "$EVOLUTION_MESSAGE_DAYS" =~ ^[0-9]+$ ]] && (( EVOLUTION_MESSAGE_DAYS > 0 )); then
    local sum=0
    # Por tandas: la primera vez puede haber meses de mensajes y una sola orden tomaría la tabla demasiado tiempo.
    for _ in $(seq 1 200); do
      n="$(psql -X -At -v ON_ERROR_STOP=1 -d "$EVOLUTION_DB" -v days="$EVOLUTION_MESSAGE_DAYS" <<'SQL'
WITH gone AS (DELETE FROM "Message" WHERE ctid IN (SELECT ctid FROM "Message" WHERE "messageTimestamp" < extract(epoch FROM now() - make_interval(days => :'days'::int)) LIMIT 5000) RETURNING 1)
SELECT count(*) FROM gone;
SQL
)" || { log "Limpieza de Evolution: falló la retención de mensajes; se sigue en la próxima vuelta."; return 1; }
      sum=$((sum + ${n:-0}))
      (( ${n:-0} < 5000 )) && break
    done
    (( sum > 0 )) && log "Limpieza de Evolution: $sum mensajes de más de $EVOLUTION_MESSAGE_DAYS días borrados."
  fi
  return 0
}

seconds_until() { # HH:MM (UTC) → segundos hasta la próxima vez
  local target now
  target="$(date -u -d "today ${1}" +%s)"; now="$(date -u +%s)"
  (( target <= now )) && target="$(date -u -d "tomorrow ${1}" +%s)"
  echo $(( target - now ))
}

case "${1:-daemon}" in
  now) run_now ;;
  verify) verify_backup "${2:-}" ;;
  restore) restore "${2:-}" ;;
  evolution-cleanup) evolution_cleanup ;;
  list) { ls -lh "$BACKUP_DIR"/riverrun-*.tar "$BACKUP_DIR"/riverrun-*.tar.enc 2>/dev/null; true; } | grep . || echo "Todavía no hay respaldos."; [[ -f "$STATUS" ]] && cat "$STATUS" ;;
  daemon)
    need_passphrase
    log "Respaldos diarios a las $BACKUP_HOUR UTC (conserva ${KEEP_DAILY} diarios, ${KEEP_WEEKLY} semanales, ${KEEP_MONTHLY} mensuales)${REMOTE:+; copia en $REMOTE}."
    # Si no hay ningún respaldo todavía, el primero se hace al arrancar (sin esperar a la noche).
    [[ -z "$(latest_file)" ]] && { run_now || true; }
    # Cada hora: la limpieza de Evolution (INF-8); a BACKUP_HOUR, además, el respaldo.
    next=$(( $(date -u +%s) + $(seconds_until "$BACKUP_HOUR") ))
    while true; do
      evolution_cleanup || true
      wait=$(( next - $(date -u +%s) )); (( wait > 3600 )) && wait=3600
      (( wait > 0 )) && sleep "$wait"
      if (( $(date -u +%s) >= next )); then
        run_now || log "El respaldo falló; se reintenta mañana (o corre './riverrun backup')."
        next=$(( $(date -u +%s) + $(seconds_until "$BACKUP_HOUR") ))
      fi
    done ;;
  *) die "Uso: backup.sh daemon|now|verify [archivo]|restore archivo|list|evolution-cleanup" ;;
esac
