#!/usr/bin/env bash
# ms-backup-restore-from-s3.sh — restore test of an offsite backup into a
# NAMED scratch database (plans/s3-storage Phase 1, "monthly restore test").
#
#   1. picks the dump: --date (reads manifests/<date>.json) or --key
#      (keys are role-relative; S3_BACKUP_PREFIX, default `backups/`, is
#      prepended like the backup script does)
#   2. downloads it, compares size + sha256 with the object's metadata
#      (HeadObject; when the key may not call it, the listed size only)
#   3. pg_restore into --target-db (created with --create-db), never into
#      the live database unless --allow-live is given explicitly
#   4. prints row counts of a few tables so the result can be logged
#   5. optional: --files-dir DIR extracts the files archive there
#
# The database password comes from DATABASE_URL in the API .env through a
# 0600 PGPASSFILE; the restore user is the app user (it may create a
# database when it has CREATEDB, otherwise create it as postgres first).
#
# Exit codes: 0 ok · 1 failure · 2 usage/config · 5 download/verify failed
# · 6 pg_restore failed. Logs to BACKUP_DIR/offsite-restore.log.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ms-ops-lib.sh
. "$SCRIPT_DIR/ms-ops-lib.sh"

API_DIR="${MS_API_DIR:-/var/www/multi-stores-api}"
ENV_FILE=""
TARGET_DB=""
DATE=""
KEY=""
CREATE_DB=0
ALLOW_LIVE=0
FILES_DIR=""
KEEP_DOWNLOAD=0

usage() {
  cat <<EOF
Usage: $(basename "$0") --target-db NAME (--date YYYY-MM-DD | --key db/<date>/<file>.dump)
                                   [--create-db] [--files-dir DIR] [--keep] [--api-dir DIR] [--env FILE]
                                   [--allow-live]

  --target-db NAME  scratch database to restore into (required; refused when it is the live DB)
  --date DATE       use the dump listed in manifests/<DATE>.json
  --key KEY         role-relative key of the dump, e.g. db/<date>/<file>.dump (overrides --date)
  --create-db       createdb NAME first (needs CREATEDB on the app role, or run as postgres)
  --files-dir DIR   also download the files archive of that day and extract it into DIR
  --keep            keep the downloaded files under BACKUP_DIR/offsite/restore-test/
  --allow-live      allow NAME to be the live database (destructive: --clean --if-exists)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --date) DATE="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --create-db) CREATE_DB=1; shift ;;
    --files-dir) FILES_DIR="$2"; shift 2 ;;
    --keep) KEEP_DOWNLOAD=1; shift ;;
    --allow-live) ALLOW_LIVE=1; shift ;;
    --api-dir) API_DIR="$2"; shift 2 ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; ms_die 2 "unknown option: $1" ;;
  esac
done
[ -n "$TARGET_DB" ] || { usage >&2; ms_die 2 "--target-db is required"; }
case "$TARGET_DB" in *[!A-Za-z0-9_]*) ms_die 2 "--target-db: letters, digits and _ only" ;; esac
[ -n "$DATE" ] || [ -n "$KEY" ] || { usage >&2; ms_die 2 "--date or --key is required"; }
if [ -n "$DATE" ]; then
  case "$DATE" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) ms_die 2 "--date must be YYYY-MM-DD" ;; esac
fi
ENV_FILE="${ENV_FILE:-$API_DIR/.env}"
[ -r "$ENV_FILE" ] || ms_die 2 "cannot read env file $ENV_FILE"

# ── Configuration ─────────────────────────────────────────────────────────────
DATABASE_URL="$(ms_env_get DATABASE_URL)"
BACKUP_DIR="$(ms_env_get BACKUP_DIR)"
BACKUP_DIR="${BACKUP_DIR:-$API_DIR/backups}"
BUCKET="$(ms_env_get S3_BACKUP_BUCKET)"
PREFIX="$(ms_s3_prefix S3_BACKUP_PREFIX backups/)"
S3_ENDPOINT="$(ms_env_get S3_ENDPOINT)"
[ -n "$DATABASE_URL" ] || ms_die 2 "DATABASE_URL missing in $ENV_FILE"
[ -n "$BUCKET" ] || ms_die 2 "S3_BACKUP_BUCKET missing in $ENV_FILE"
ms_parse_db_url "$DATABASE_URL" || ms_die 2 "DATABASE_URL could not be parsed"
unset DATABASE_URL
ms_export_aws_env

if [ "$TARGET_DB" = "$DB_NAME" ] && [ "$ALLOW_LIVE" -ne 1 ]; then
  ms_die 2 "refusing to restore into the live database '$DB_NAME' (pass --allow-live if you really mean it)"
fi

mkdir -p "$BACKUP_DIR/offsite"
LOG_FILE="$BACKUP_DIR/offsite-restore.log"
ms_require_tool pg_restore psql sha256sum aws
ENDPOINT_ARGS=()
if [ -n "$S3_ENDPOINT" ]; then ENDPOINT_ARGS=(--endpoint-url "$S3_ENDPOINT"); fi
s3() { aws ${ENDPOINT_ARGS[@]+"${ENDPOINT_ARGS[@]}"} "$@"; }
s3key() { printf '%s%s' "$PREFIX" "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ms-restore.XXXXXX")"
KEEP_DIR="$BACKUP_DIR/offsite/restore-test"
cleanup() {
  if [ "$KEEP_DOWNLOAD" -eq 1 ] && [ -d "$WORK" ]; then
    mkdir -p "$KEEP_DIR"
    find "$WORK" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.tar.gz' -o -name '*.json' \) -exec mv -f {} "$KEEP_DIR"/ \; 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
ms_write_pgpass "$WORK"
mapfile -t PG_ARGS < <(ms_pg_args)
START=$(date +%s)
ms_log "restore test start: target=$TARGET_DB bucket=s3://$BUCKET/$PREFIX ${KEY:+key=$KEY}${DATE:+date=$DATE} live_db=$DB_NAME"

# ── 1. Which dump ─────────────────────────────────────────────────────────────
json_field() {
  # json_field <file> <name> — flat string/number field of the manifest
  sed -n "s/^[[:space:]]*\"$2\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*$/\1/p" "$1" | head -n 1
}
FILES_KEY=""
FILES_SHA=""
if [ -z "$KEY" ]; then
  MANIFEST="$WORK/manifest.json"
  if ! s3 s3 cp "s3://$BUCKET/$(s3key "manifests/$DATE.json")" "$MANIFEST" --only-show-errors 2>"$WORK/aws.err"; then
    ms_die 5 "no success marker for $DATE: $(tail -c 400 "$WORK/aws.err" | tr '\n' ' ')"
  fi
  KEY="$(json_field "$MANIFEST" db_key)"
  [ -n "$KEY" ] || ms_die 5 "manifests/$DATE.json has no db_key"
  FILES_KEY="$(json_field "$MANIFEST" files_key)"
  [ "$FILES_KEY" = "null" ] && FILES_KEY=""
  FILES_SHA="$(json_field "$MANIFEST" files_sha256)"
  ms_log "manifest $DATE: db_key=$KEY files_key=${FILES_KEY:-none}"
fi

# ── 2. Download + verify ──────────────────────────────────────────────────────
fetch() {
  # fetch <role-relative key> <local file>
  local rkey="$1" file="$2" key out size rsha lsize lsha
  key="$(s3key "$rkey")"
  if out="$(s3 s3api head-object --bucket "$BUCKET" --key "$key" \
    --query '[ContentLength, Metadata.sha256]' --output text 2>"$WORK/aws.err")"; then
    read -r size rsha <<<"$out"
  else
    # HeadObject refused (key without that action): the listing gives the
    # size; the sha256 metadata stays unknown (the manifest still has it).
    ms_log "head-object refused for $key, using list-objects-v2 (size only)"
    if ! size="$(s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "$key" \
      --query "Contents[?Key=='$key'].Size | [0]" --output text 2>"$WORK/aws.err")"; then
      ms_die 5 "list-objects-v2 failed for $key: $(tail -c 400 "$WORK/aws.err" | tr '\n' ' ')"
    fi
    [ "$size" != "None" ] || ms_die 5 "no such object: $key"
    rsha="None"
  fi
  if ! s3 s3 cp "s3://$BUCKET/$key" "$file" --only-show-errors 2>"$WORK/aws.err"; then
    ms_die 5 "download failed for $key: $(tail -c 400 "$WORK/aws.err" | tr '\n' ' ')"
  fi
  lsize="$(ms_size "$file")"
  lsha="$(ms_sha256 "$file")"
  if [ "$lsize" != "$size" ]; then
    ms_die 5 "size mismatch for $key: object $size, downloaded $lsize"
  fi
  if [ -n "$rsha" ] && [ "$rsha" != "None" ] && [ "$rsha" != "$lsha" ]; then
    ms_die 5 "sha256 mismatch for $key: object $rsha, downloaded $lsha"
  fi
  ms_log "downloaded + verified $key ($(ms_human "$lsize") sha256=$lsha)"
}
DUMP="$WORK/$(basename "$KEY")"
fetch "$KEY" "$DUMP"

# ── 3. Restore ────────────────────────────────────────────────────────────────
if [ "$CREATE_DB" -eq 1 ]; then
  if ! createdb "${PG_ARGS[@]}" "$TARGET_DB" 2>"$WORK/createdb.err"; then
    ms_die 6 "createdb $TARGET_DB failed: $(tail -c 400 "$WORK/createdb.err" | tr '\n' ' ')"
  fi
  ms_log "created database $TARGET_DB"
fi
RESTORE_ARGS=(--no-owner --no-privileges)
if [ "$ALLOW_LIVE" -eq 1 ] && [ "$TARGET_DB" = "$DB_NAME" ]; then
  RESTORE_ARGS+=(--clean --if-exists)
  ms_log "WARNING: restoring into the LIVE database $DB_NAME"
fi
if ! pg_restore "${RESTORE_ARGS[@]}" "${PG_ARGS[@]}" -d "$TARGET_DB" "$DUMP" 2>"$WORK/pg_restore.err"; then
  ms_die 6 "pg_restore failed: $(tail -c 800 "$WORK/pg_restore.err" | tr '\n' ' ')"
fi
ms_log "pg_restore ok into $TARGET_DB"

# ── 4. Smoke checks ───────────────────────────────────────────────────────────
count() {
  psql "${PG_ARGS[@]}" -d "$TARGET_DB" -Atqc "SELECT count(*) FROM \"$1\"" 2>/dev/null || echo '?'
}
LAST_ORDER="$(psql "${PG_ARGS[@]}" -d "$TARGET_DB" -Atqc 'SELECT max(created_at) FROM "Order"' 2>/dev/null || echo '?')"
ms_log "smoke: Store=$(count Store) User=$(count User) Product=$(count Product) Order=$(count Order) last_order=$LAST_ORDER migrations=$(count _prisma_migrations)"

# ── 5. Files (optional) ───────────────────────────────────────────────────────
if [ -n "$FILES_DIR" ]; then
  [ -n "$FILES_KEY" ] || ms_die 5 "--files-dir given but the manifest has no files archive (use --date)"
  ARCHIVE="$WORK/$(basename "$FILES_KEY")"
  fetch "$FILES_KEY" "$ARCHIVE"
  if [ -n "$FILES_SHA" ] && [ "$FILES_SHA" != "null" ] && [ "$FILES_SHA" != "$(ms_sha256 "$ARCHIVE")" ]; then
    ms_die 5 "files archive sha256 differs from the manifest"
  fi
  mkdir -p "$FILES_DIR"
  tar -xzf "$ARCHIVE" -C "$FILES_DIR"
  ms_log "files extracted into $FILES_DIR: $(find "$FILES_DIR" -type f | wc -l) files"
fi

ms_log "restore test done in $(($(date +%s) - START))s: $KEY -> $TARGET_DB"
printf '\nRestore test OK: %s -> %s (%ss). Drop the scratch DB afterwards: dropdb %s\n' "$KEY" "$TARGET_DB" "$(($(date +%s) - START))" "$TARGET_DB"
exit 0
