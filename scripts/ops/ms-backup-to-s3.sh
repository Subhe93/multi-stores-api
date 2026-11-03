#!/usr/bin/env bash
# ms-backup-to-s3.sh — nightly offsite backup of the multi-stores API
# (plans/s3-storage/SPEC.md "Backups", Phase 1). Runs as `multistores` from
# cron (see scripts/ops/README.md for the cron line):
#   1. pg_dump -Fc of DATABASE_URL (password through a 0600 PGPASSFILE)
#   2. tar.gz of PRIVATE_STORAGE_DIR + INVOICE_STORAGE_DIR
#      (+ uploads/ while STORAGE_DRIVER is not s3)
#   3. sha256 manifest, upload with SSE-KMS (S3_KMS_KEY_ID) or SSE-S3 via
#      `aws s3api put-object --checksum-sha256` (S3 refuses a body that does
#      not hash to it), tagged `tier=daily|weekly|monthly` (Sunday = weekly,
#      1st of the month = monthly; INFRA.md §3.5) and, for weekly/monthly,
#      locked per object (GOVERNANCE, 56 d / 365 d)
#   4. size verification with `aws s3api list-objects-v2` on the key (the
#      `ms-backup-writer` policy has no GetObject/HeadObject, INFRA.md §5.2)
#   5. success marker manifests/<yyyy-mm-dd>.json (tagged like the dump)
#   6. local cleanup: the last --keep dumps stay in BACKUP_DIR/offsite
#
# Credentials: AWS_* already in the environment win (the cron line sources
# /etc/multi-stores/backup-aws.env), then BACKUP_AWS_* from the .env, then
# the API's AWS_* (see ms_export_aws_env).
#
# Object keys:  db/<date>/db-<stamp>.dump
#               files/<date>/files-<stamp>.tar.gz
#               manifests/<date>.json
#
# Exit codes: 0 ok · 1 failure · 2 usage/config · 3 lock held · 4 dump or
# archive failed · 5 upload or verification failed. Logs to
# BACKUP_DIR/offsite.log; no secret is ever printed.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ms-ops-lib.sh
. "$SCRIPT_DIR/ms-ops-lib.sh"

API_DIR="${MS_API_DIR:-/var/www/multi-stores-api}"
ENV_FILE=""
DRY_RUN=0
KEEP_LOCAL="${MS_BACKUP_KEEP_LOCAL:-2}"
DB_ONLY=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--api-dir DIR] [--env FILE] [--keep N] [--db-only] [--dry-run]

  --api-dir DIR   API working directory (default: \$MS_API_DIR or /var/www/multi-stores-api)
  --env FILE      .env to read (default: <api-dir>/.env)
  --keep N        local dumps/archives to keep in BACKUP_DIR/offsite (default: 2)
  --db-only       skip the files archive
  --dry-run       print the plan (dirs, bucket, keys), touch nothing, upload nothing
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api-dir) API_DIR="$2"; shift 2 ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    --keep) KEEP_LOCAL="$2"; shift 2 ;;
    --db-only) DB_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; ms_die 2 "unknown option: $1" ;;
  esac
done
ENV_FILE="${ENV_FILE:-$API_DIR/.env}"
[ -r "$ENV_FILE" ] || ms_die 2 "cannot read env file $ENV_FILE"
case "$KEEP_LOCAL" in '' | *[!0-9]*) ms_die 2 "--keep must be a number" ;; esac

# ── Configuration (parsed, never sourced) ────────────────────────────────────
DATABASE_URL="$(ms_env_get DATABASE_URL)"
BACKUP_DIR="$(ms_env_get BACKUP_DIR)"
BACKUP_DIR="${BACKUP_DIR:-$API_DIR/backups}"
BUCKET="$(ms_env_get S3_BACKUP_BUCKET)"
KMS_KEY_ID="$(ms_env_get S3_KMS_KEY_ID)"
S3_ENDPOINT="$(ms_env_get S3_ENDPOINT)"
STORAGE_DRIVER="$(ms_env_get STORAGE_DRIVER)"
STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
PRIVATE_STORAGE_DIR="$(ms_env_get PRIVATE_STORAGE_DIR)"
PRIVATE_STORAGE_DIR="${PRIVATE_STORAGE_DIR:-$API_DIR/storage}"
INVOICE_STORAGE_DIR="$(ms_env_get INVOICE_STORAGE_DIR)"
INVOICE_STORAGE_DIR="${INVOICE_STORAGE_DIR:-$PRIVATE_STORAGE_DIR/invoices}"
UPLOADS_DIR="$API_DIR/uploads"

[ -n "$DATABASE_URL" ] || ms_die 2 "DATABASE_URL missing in $ENV_FILE"
[ -n "$BUCKET" ] || ms_die 2 "S3_BACKUP_BUCKET missing in $ENV_FILE"
ms_parse_db_url "$DATABASE_URL" || ms_die 2 "DATABASE_URL could not be parsed"
unset DATABASE_URL
ms_export_aws_env

mkdir -p "$BACKUP_DIR/offsite"
LOG_FILE="$BACKUP_DIR/offsite.log"
LOCAL_DIR="$BACKUP_DIR/offsite"

ms_require_tool pg_dump tar sha256sum xxd base64 aws flock

# ── Lock ──────────────────────────────────────────────────────────────────────
exec 9>"$BACKUP_DIR/offsite.lock"
if ! flock -n 9; then
  ms_die 3 "another offsite backup is running (lock $BACKUP_DIR/offsite.lock)"
fi

# ── Plan ──────────────────────────────────────────────────────────────────────
NOW_EPOCH="$(date +%s)"
STAMP="$(date -d "@$NOW_EPOCH" +%Y%m%d-%H%M%S)"
DATE="$(date -u -d "@$NOW_EPOCH" +%F)"
DUMP_NAME="db-$STAMP.dump"
FILES_NAME="files-$STAMP.tar.gz"
DB_KEY="db/$DATE/$DUMP_NAME"
FILES_KEY="files/$DATE/$FILES_NAME"
MANIFEST_KEY="manifests/$DATE.json"
TIER="$(ms_backup_tier "$NOW_EPOCH")"
RETAIN_UNTIL="$(ms_retain_until "$TIER" "$NOW_EPOCH")"

ARCHIVE_DIRS=()
add_dir() {
  [ -d "$1" ] || { ms_log "skip (not a directory): $1"; return 0; }
  ARCHIVE_DIRS+=("$1")
}
if [ "$DB_ONLY" -eq 0 ]; then
  if [ "$STORAGE_DRIVER" != "s3" ]; then add_dir "$UPLOADS_DIR"; fi
  add_dir "$PRIVATE_STORAGE_DIR"
  case "${INVOICE_STORAGE_DIR%/}/" in
    "${PRIVATE_STORAGE_DIR%/}/"*) ms_log "invoice dir is inside the private dir; covered" ;;
    *) add_dir "$INVOICE_STORAGE_DIR" ;;
  esac
fi

# s3api put-object flags (the `s3 cp` spellings differ).
SSE_ARGS=(--server-side-encryption AES256)
SSE_LABEL="SSE-S3"
if [ -n "$KMS_KEY_ID" ]; then
  SSE_ARGS=(--server-side-encryption aws:kms --ssekms-key-id "$KMS_KEY_ID")
  SSE_LABEL="SSE-KMS"
fi
LOCK_ARGS=()
if [ -n "$RETAIN_UNTIL" ]; then
  LOCK_ARGS=(--object-lock-mode GOVERNANCE --object-lock-retain-until-date "$RETAIN_UNTIL")
fi
ENDPOINT_ARGS=()
if [ -n "$S3_ENDPOINT" ]; then ENDPOINT_ARGS=(--endpoint-url "$S3_ENDPOINT"); fi

ms_log "offsite backup start: db=$DB_NAME@$DB_HOST:$DB_PORT bucket=s3://$BUCKET $SSE_LABEL tier=$TIER${RETAIN_UNTIL:+ lock_until=$RETAIN_UNTIL} driver=$STORAGE_DRIVER dirs=${#ARCHIVE_DIRS[@]} keep=$KEEP_LOCAL aws_key=$MS_AWS_KEY_SOURCE dry_run=$DRY_RUN"
if [ "$DRY_RUN" -eq 1 ]; then
  ms_log "plan: pg_dump -Fc -> $LOCAL_DIR/$DUMP_NAME -> s3://$BUCKET/$DB_KEY"
  if [ ${#ARCHIVE_DIRS[@]} -gt 0 ]; then
    ms_log "plan: tar -czf $LOCAL_DIR/$FILES_NAME ${ARCHIVE_DIRS[*]} -> s3://$BUCKET/$FILES_KEY"
  fi
  ms_log "plan: marker s3://$BUCKET/$MANIFEST_KEY; tag tier=$TIER${RETAIN_UNTIL:+; Object Lock GOVERNANCE until $RETAIN_UNTIL}; aws identity: $(aws ${ENDPOINT_ARGS[@]+"${ENDPOINT_ARGS[@]}"} sts get-caller-identity --query Arn --output text 2>/dev/null || echo unavailable)"
  ms_log "dry run done"
  exit 0
fi

# ── Work dir + pgpass (removed on exit) ──────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ms-offsite.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
ms_write_pgpass "$WORK"
mapfile -t PG_ARGS < <(ms_pg_args)
START=$(date +%s)

# ── 1. Dump ───────────────────────────────────────────────────────────────────
DUMP="$LOCAL_DIR/$DUMP_NAME"
if ! pg_dump -Fc --no-owner --no-privileges "${PG_ARGS[@]}" -d "$DB_NAME" -f "$DUMP" 2>"$WORK/pg_dump.err"; then
  rm -f "$DUMP"
  ms_die 4 "pg_dump failed: $(tail -c 600 "$WORK/pg_dump.err" | tr '\n' ' ')"
fi
DUMP_BYTES="$(ms_size "$DUMP")"
DUMP_SHA="$(ms_sha256 "$DUMP")"
ms_log "dump ok: $DUMP_NAME $(ms_human "$DUMP_BYTES") sha256=$DUMP_SHA"

# ── 2. Files archive ──────────────────────────────────────────────────────────
FILES=""
FILES_BYTES=0
FILES_SHA=""
if [ ${#ARCHIVE_DIRS[@]} -gt 0 ]; then
  FILES="$LOCAL_DIR/$FILES_NAME"
  TAR_ARGS=(-czf "$FILES" --exclude='.*.tmp')
  for d in "${ARCHIVE_DIRS[@]}"; do
    TAR_ARGS+=(-C "$(dirname "$d")" "$(basename "$d")")
  done
  set +e
  tar "${TAR_ARGS[@]}" 2>"$WORK/tar.err"
  TAR_RC=$?
  set -e
  if [ "$TAR_RC" -eq 1 ]; then
    # GNU tar 1 = "file changed / removed as we read it": private storage
    # writes are atomic (temp + rename), so the archive is still valid.
    ms_log "tar warned (tolerated): $(tail -c 300 "$WORK/tar.err" | tr '\n' ' ')"
  elif [ "$TAR_RC" -ne 0 ]; then
    rm -f "$FILES"
    ms_die 4 "tar failed ($TAR_RC): $(tail -c 600 "$WORK/tar.err" | tr '\n' ' ')"
  fi
  FILES_BYTES="$(ms_size "$FILES")"
  FILES_SHA="$(ms_sha256 "$FILES")"
  ms_log "archive ok: $FILES_NAME $(ms_human "$FILES_BYTES") sha256=$FILES_SHA"
fi

# ── 3+4. Upload + verify ──────────────────────────────────────────────────────
# One PutObject carries the checksum (S3 fails the request on a mismatch),
# the sha256 metadata, the tier tag and the per-object lock. put-object is
# limited to 5 GB; larger files go through `s3 cp` (multipart) and get tag +
# retention with two follow-up calls. Verification lists the key (the writer
# policy has no GetObject/HeadObject).
PUT_OBJECT_MAX=$((5 * 1024 * 1024 * 1024))
upload() {
  # upload <local file> <key> <sha256> <content type>
  local file="$1" key="$2" sha="$3" ctype="$4" expect size
  expect="$(ms_size "$file")"
  if [ "$expect" -le "$PUT_OBJECT_MAX" ]; then
    if ! aws ${ENDPOINT_ARGS[@]+"${ENDPOINT_ARGS[@]}"} s3api put-object \
      --bucket "$BUCKET" --key "$key" --body "$file" \
      --checksum-sha256 "$(ms_sha256_b64 "$file")" \
      "${SSE_ARGS[@]}" --metadata "sha256=$sha" --content-type "$ctype" \
      --tagging "tier=$TIER" ${LOCK_ARGS[@]+"${LOCK_ARGS[@]}"} \
      --output text --query ETag >/dev/null 2>"$WORK/aws.err"; then
      ms_die 5 "upload failed for $key: $(tail -c 600 "$WORK/aws.err" | tr '\n' ' ')"
    fi
  else
    local cp_sse=(--sse AES256)
    [ -n "$KMS_KEY_ID" ] && cp_sse=(--sse aws:kms --sse-kms-key-id "$KMS_KEY_ID")
    if ! aws ${ENDPOINT_ARGS[@]+"${ENDPOINT_ARGS[@]}"} s3 cp "$file" "s3://$BUCKET/$key" \
      "${cp_sse[@]}" --metadata "sha256=$sha" --content-type "$ctype" \
      --only-show-errors 2>"$WORK/aws.err"; then
      ms_die 5 "upload failed for $key: $(tail -c 600 "$WORK/aws.err" | tr '\n' ' ')"
    fi
    if ! aws ${ENDPOINT_ARGS[@]+"${ENDPOINT_ARGS[@]}"} s3api put-object-tagging \
      --bucket "$BUCKET" --key "$key" \
      --tagging "{\"TagSet\":[{\"Key\":\"tier\",\"Value\":\"$TIER\"}]}" 2>"$WORK/aws.err"; then
      ms_die 5 "put-object-tagging failed for $key: $(tail -c 600 "$WORK/aws.err" | tr '\n' ' ')"
    fi
    if [ -n "$RETAIN_UNTIL" ]; then
      if ! aws ${ENDPOINT_ARGS[@]+"${ENDPOINT_ARGS[@]}"} s3api put-object-retention \
        --bucket "$BUCKET" --key "$key" \
        --retention "{\"Mode\":\"GOVERNANCE\",\"RetainUntilDate\":\"$RETAIN_UNTIL\"}" 2>"$WORK/aws.err"; then
        ms_die 5 "put-object-retention failed for $key: $(tail -c 600 "$WORK/aws.err" | tr '\n' ' ')"
      fi
    fi
  fi
  if ! size="$(aws ${ENDPOINT_ARGS[@]+"${ENDPOINT_ARGS[@]}"} s3api list-objects-v2 \
    --bucket "$BUCKET" --prefix "$key" \
    --query "Contents[?Key=='$key'].Size | [0]" --output text 2>"$WORK/aws.err")"; then
    ms_die 5 "list-objects-v2 failed for $key: $(tail -c 600 "$WORK/aws.err" | tr '\n' ' ')"
  fi
  if [ "$size" != "$expect" ]; then
    ms_die 5 "verification failed for $key: listed size=$size, local size=$expect"
  fi
  ms_log "verified s3://$BUCKET/$key ($(ms_human "$size"), tier=$TIER)"
}

upload "$DUMP" "$DB_KEY" "$DUMP_SHA" application/octet-stream
if [ -n "$FILES" ]; then
  upload "$FILES" "$FILES_KEY" "$FILES_SHA" application/gzip
fi

# ── 5. Success marker ─────────────────────────────────────────────────────────
MANIFEST="$WORK/manifest.json"
{
  printf '{\n'
  printf '  "version": 1,\n  "source": "cron",\n  "host": "%s",\n' "$(hostname)"
  printf '  "date": "%s",\n  "created_at": "%s",\n' "$DATE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "database": "%s",\n  "storage_driver": "%s",\n  "encryption": "%s",\n  "tier": "%s",\n' "$DB_NAME" "$STORAGE_DRIVER" "$SSE_LABEL" "$TIER"
  printf '  "db_key": "%s",\n  "db_bytes": %s,\n  "db_sha256": "%s",\n' "$DB_KEY" "$DUMP_BYTES" "$DUMP_SHA"
  if [ -n "$FILES" ]; then
    printf '  "files_key": "%s",\n  "files_bytes": %s,\n  "files_sha256": "%s",\n' "$FILES_KEY" "$FILES_BYTES" "$FILES_SHA"
    printf '  "files_dirs": ['
    sep=""
    for d in "${ARCHIVE_DIRS[@]}"; do printf '%s"%s"' "$sep" "$d"; sep=", "; done
    printf '],\n'
  else
    printf '  "files_key": null,\n  "files_bytes": null,\n  "files_sha256": null,\n  "files_dirs": [],\n'
  fi
  printf '  "duration_s": %s\n}\n' "$(($(date +%s) - START))"
} >"$MANIFEST"
upload "$MANIFEST" "$MANIFEST_KEY" "$(ms_sha256 "$MANIFEST")" application/json
cp "$MANIFEST" "$LOCAL_DIR/manifest-$DATE.json"

# ── 6. Local cleanup (S3 lifecycle owns the remote retention) ────────────────
prune() {
  # prune <glob> — keep the newest $KEEP_LOCAL matches
  local removed=0 f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rm -f -- "$f" && removed=$((removed + 1))
  done < <(ls -1t "$LOCAL_DIR"/$1 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))")
  [ "$removed" -gt 0 ] && ms_log "pruned $removed local $1"
  return 0
}
prune 'db-*.dump'
prune 'files-*.tar.gz'
prune 'manifest-*.json'

ms_log "offsite backup done in $(($(date +%s) - START))s: $DB_KEY${FILES:+ + $FILES_KEY} (marker $MANIFEST_KEY)"
exit 0
