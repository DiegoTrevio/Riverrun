#!/usr/bin/env bash
# Respaldos de Riverrun: bases de datos (chatbot y Evolution), fotos subidas y sesiones de WhatsApp.
#
#   backup.sh daemon        un respaldo cada día a BACKUP_HOUR (UTC) — es lo que corre el contenedor "backup"
#   backup.sh now           respaldo inmediato
#   backup.sh verify [FILE] comprueba que el respaldo (el último por defecto) se puede restaurar
#   backup.sh restore FILE  restaura (FILE o "latest"); con el sistema detenido salvo PostgreSQL
#   backup.sh list          lista los respaldos
#
# Cada respaldo es un solo archivo .tar.enc cifrado con BACKUP_PASSPHRASE (AES-256). Sin la clave no se puede
# leer: guárdala fuera del servidor (gestor de contraseñas).
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
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-chatbot}" PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
STATUS="$BACKUP_DIR/status.json"

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

encrypt() { if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE; else cat; fi; }
decrypt() { if [[ "$1" == *.enc ]]; then openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE < "$1"; else cat "$1"; fi; }

wait_for_db() {
  for _ in $(seq 1 30); do pg_isready -q && return 0; sleep 2; done
  die "PostgreSQL no responde en $PGHOST"
}

latest_file() { { printf '%s\n' "$BACKUP_DIR"/riverrun-*.tar "$BACKUP_DIR"/riverrun-*.tar.enc | grep -v '[*]' || true; } | sort | tail -n 1; }

make_backup() {
  need_passphrase
  mkdir -p "$BACKUP_DIR"
  rm -f "$BACKUP_DIR"/*.partial # restos de un respaldo interrumpido
  wait_for_db
  local ts work out
  ts="$(date -u +%Y%m%d-%H%M%S)"
  work="$BACKUP_DIR/.work"
  rm -rf "$work"; mkdir -p "$work" # (un intento anterior interrumpido deja restos aquí)
  log "Respaldo $ts: bases de datos"
  for db in $DATABASES; do
    pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$db" --file="$work/$db.dump"
  done
  log "Respaldo $ts: archivos"
  if [[ -d "$UPLOADS_DIR" ]]; then tar -C "$UPLOADS_DIR" -czf "$work/uploads.tar.gz" .; else : > "$work/uploads.tar.gz"; fi
  if [[ -d "$EVOLUTION_DIR" ]]; then tar -C "$EVOLUTION_DIR" -czf "$work/evolution_instances.tar.gz" .; else : > "$work/evolution_instances.tar.gz"; fi
  ( cd "$work" && sha256sum ./* > SHA256SUMS )
  echo "{\"created_at\": \"$(date -u +%FT%TZ)\", \"databases\": \"$DATABASES\", \"version\": \"${APP_VERSION:-unknown}\"}" > "$work/manifest.json"
  local suffix="tar.enc"; [[ -z "${BACKUP_PASSPHRASE:-}" ]] && suffix="tar"
  out="$BACKUP_DIR/${BACKUP_PREFIX:-riverrun}-$ts.$suffix" # el respaldo previo a restaurar usa otro prefijo para que "latest" no lo elija
  tar -C "$work" -cf - . | encrypt > "$out.partial"
  mv "$out.partial" "$out"
  rm -rf "$work"
  chmod 600 "$out"
  log "Respaldo creado: $(basename "$out") ($(du -h "$out" | cut -f1))"
  echo "$out"
}

verify_backup() { # FILE → restaura en una base temporal y cuenta tablas
  local file="${1:-$(latest_file)}"
  [[ -f "$file" ]] || { fail "No hay respaldos que verificar"; return 1; }
  need_passphrase
  wait_for_db
  local work; work="$(mktemp -d "$BACKUP_DIR/.verify.XXXXXX")"; TMP_DIRS+=("$work")
  decrypt "$file" | tar -C "$work" -xf - 2>/dev/null || { fail "No se pudo abrir $(basename "$file") (¿clave incorrecta o archivo dañado?)"; return 1; }
  ( cd "$work" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) || { fail "Las sumas de verificación no coinciden: respaldo dañado"; return 1; }
  local f
  for f in uploads.tar.gz evolution_instances.tar.gz; do
    [[ ! -s "$work/$f" ]] || tar -tzf "$work/$f" >/dev/null 2>&1 || { fail "$f dañado"; return 1; }
  done
  local dump
  for dump in "$work"/*.dump; do pg_restore --list "$dump" >/dev/null 2>&1 || { fail "$(basename "$dump") no es legible"; return 1; }; done
  # Prueba real: restaurar la base principal en una base temporal.
  local main="${DATABASES%% *}"
  dropdb --if-exists riverrun_verify >/dev/null 2>&1 || true
  createdb riverrun_verify
  pg_restore --no-owner --exit-on-error --dbname=riverrun_verify "$work/$main.dump" >/dev/null 2>&1 || { fail "No se pudo restaurar la base $main en una base de prueba"; return 1; }
  local tables; tables="$(psql -At -d riverrun_verify -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  dropdb --if-exists riverrun_verify >/dev/null 2>&1 || true
  [[ "${tables:-0}" -gt 0 ]] || { fail "La base restaurada está vacía"; return 1; }
  log "Verificado: $(basename "$file") — restauración de prueba correcta ($tables tablas)"
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

push_remote() { # FILE → nube (rclone). Devuelve 0 si salió bien o no hay nube configurada.
  [[ -n "$REMOTE" ]] || return 0
  rclone copyto "$1" "$REMOTE/$(basename "$1")" --retries 3 --low-level-retries 5 2>&1 | tail -n 3 || return 1
  rclone delete "$REMOTE" --min-age "${REMOTE_KEEP_DAYS}d" --include 'riverrun-*.tar*' >/dev/null 2>&1 || true
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
  local work; work="$(mktemp -d "${TMPDIR:-/tmp}/restore.XXXXXX")"; TMP_DIRS+=("$work")
  log "Abriendo $(basename "$file")"
  decrypt "$file" | tar -C "$work" -xf - || die "No se pudo abrir el respaldo (¿clave incorrecta?)"
  ( cd "$work" && sha256sum -c SHA256SUMS >/dev/null ) || die "Respaldo dañado (las sumas no coinciden)"
  for dump in "$work"/*.dump; do
    local db; db="$(basename "$dump" .dump)"
    log "Restaurando base de datos: $db"
    dropdb --if-exists --force "$db"
    createdb "$db"
    pg_restore --no-owner --exit-on-error --dbname="$db" "$dump" || die "Falló la restauración de $db"
  done
  if [[ -s "$work/uploads.tar.gz" && -d "$UPLOADS_DIR" ]]; then log "Restaurando fotos y archivos"; find "$UPLOADS_DIR" -mindepth 1 -delete; tar -C "$UPLOADS_DIR" -xzf "$work/uploads.tar.gz"; fi
  if [[ -s "$work/evolution_instances.tar.gz" && -d "$EVOLUTION_DIR" ]]; then log "Restaurando sesiones de WhatsApp"; find "$EVOLUTION_DIR" -mindepth 1 -delete; tar -C "$EVOLUTION_DIR" -xzf "$work/evolution_instances.tar.gz"; fi
  log "Restauración completa."
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
  list) { ls -lh "$BACKUP_DIR"/riverrun-*.tar "$BACKUP_DIR"/riverrun-*.tar.enc 2>/dev/null; true; } | grep . || echo "Todavía no hay respaldos."; [[ -f "$STATUS" ]] && cat "$STATUS" ;;
  daemon)
    need_passphrase
    log "Respaldos diarios a las $BACKUP_HOUR UTC (conserva ${KEEP_DAILY} diarios, ${KEEP_WEEKLY} semanales, ${KEEP_MONTHLY} mensuales)${REMOTE:+; copia en $REMOTE}."
    # Si no hay ningún respaldo todavía, el primero se hace al arrancar (sin esperar a la noche).
    [[ -z "$(latest_file)" ]] && { run_now || true; }
    while true; do
      sleep "$(seconds_until "$BACKUP_HOUR")"
      run_now || log "El respaldo falló; se reintenta mañana (o corre './riverrun backup')."
    done ;;
  *) die "Uso: backup.sh daemon|now|verify [archivo]|restore archivo|list" ;;
esac
