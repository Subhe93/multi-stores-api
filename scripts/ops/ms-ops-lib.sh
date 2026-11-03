#!/usr/bin/env bash
# Shared helpers of the ops scripts (sourced, not executed):
#   - safe .env reading (no `source`: values are parsed, never evaluated)
#   - DATABASE_URL parsing + a 0600 PGPASSFILE so no password ever reaches
#     argv, `ps` or a log line
#   - logging without secrets
# Every function is plain bash + coreutils; nothing here prints a secret.

# ── Logging ───────────────────────────────────────────────────────────────────

# LOG_FILE is set by the caller once BACKUP_DIR is known; before that lines
# only go to stdout.
LOG_FILE="${LOG_FILE:-}"

ms_log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [$$] $*"
  printf '%s\n' "$line"
  if [ -n "$LOG_FILE" ]; then printf '%s\n' "$line" >>"$LOG_FILE" || true; fi
}

ms_die() {
  # ms_die <exit code> <message>
  local code="$1"
  shift
  ms_log "ERROR: $*"
  exit "$code"
}

# ── .env reading ──────────────────────────────────────────────────────────────

# ms_env_get KEY [FILE]: value of the last `KEY=...` line (optionally
# `export KEY=...`), surrounding quotes removed, no variable expansion, no
# command substitution. Empty when the key is absent.
ms_env_get() {
  local key="$1" file="${2:-$ENV_FILE}" line
  [ -r "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"
  case "$line" in
    \"*\")
      line="${line#\"}"
      line="${line%\"}"
      ;;
    \'*\')
      line="${line#\'}"
      line="${line%\'}"
      ;;
    *)
      # Unquoted: drop a trailing ` # comment` and surrounding blanks.
      line="${line%%[[:space:]]#*}"
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$line"
}

# ms_env_has KEY [FILE]: true when a `KEY=` line exists (even with an empty
# value), so "unset" and "set to empty" can be told apart.
ms_env_has() {
  local key="$1" file="${2:-$ENV_FILE}"
  [ -r "$file" ] || return 1
  grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file"
}

# ms_env_bool KEY DEFAULT: true/1/yes/on → 0 (true), false/0/no/off or
# absent → DEFAULT (`true`|`false`).
ms_env_bool() {
  local key="$1" def="$2" v
  v="$(ms_env_get "$key" | tr '[:upper:]' '[:lower:]')"
  case "$v" in
    1 | true | yes | on) return 0 ;;
    0 | false | no | off) return 1 ;;
    '') [ "$def" = "true" ] ;;
    *) ms_die 2 "$key must be true or false (got '$v')" ;;
  esac
}

# ms_s3_prefix KEY DEFAULT: the role's key prefix inside its bucket, read
# like the API does (storage.config.ts `keyPrefixFor`): an absent KEY means
# DEFAULT, an empty value means no prefix; the result has no leading `/`
# and exactly one trailing `/` (or is empty). Refuses `..`, `\` and blanks.
ms_s3_prefix() {
  local key="$1" def="$2" v
  if ms_env_has "$key"; then v="$(ms_env_get "$key")"; else v="$def"; fi
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  while [ "${v#/}" != "$v" ]; do v="${v#/}"; done
  while [ "${v%/}" != "$v" ]; do v="${v%/}"; done
  [ -z "$v" ] && return 0
  case "$v" in
    *..* | *\\* | *[[:space:]]* | *//*) ms_die 2 "$key is not a valid key prefix: '$v'" ;;
  esac
  printf '%s/' "$v"
}

# Exports the AWS settings for the aws CLI. Precedence (first wins):
#   1. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY already in the environment
#      (the cron line sources /etc/multi-stores/backup-aws.env with the
#      `ms-backup-writer` key, INFRA.md §5.6);
#   2. BACKUP_AWS_ACCESS_KEY_ID / BACKUP_AWS_SECRET_ACCESS_KEY in the .env
#      (the same writer key when the API also uploads in-app);
#   3. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the .env (the API key;
#      the normal case when one bucket holds every role under prefixes).
# Values are never printed; the caller may log booleans only.
ms_export_aws_env() {
  local v id secret token
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    id="$(ms_env_get BACKUP_AWS_ACCESS_KEY_ID)"
    secret="$(ms_env_get BACKUP_AWS_SECRET_ACCESS_KEY)"
    token="$(ms_env_get BACKUP_AWS_SESSION_TOKEN)"
    MS_AWS_KEY_SOURCE="backup-env"
    if [ -z "$id" ] || [ -z "$secret" ]; then
      id="$(ms_env_get AWS_ACCESS_KEY_ID)"
      secret="$(ms_env_get AWS_SECRET_ACCESS_KEY)"
      token="$(ms_env_get AWS_SESSION_TOKEN)"
      MS_AWS_KEY_SOURCE="api-env"
    fi
    if [ -n "$id" ] && [ -n "$secret" ]; then
      export AWS_ACCESS_KEY_ID="$id"
      export AWS_SECRET_ACCESS_KEY="$secret"
      if [ -n "$token" ]; then export AWS_SESSION_TOKEN="$token"; else unset AWS_SESSION_TOKEN; fi
    else
      MS_AWS_KEY_SOURCE="default-chain"
    fi
  else
    MS_AWS_KEY_SOURCE="environment"
  fi
  export MS_AWS_KEY_SOURCE
  if [ -z "${AWS_REGION:-}" ]; then
    v="$(ms_env_get AWS_REGION)"
    [ -n "$v" ] && export AWS_REGION="$v"
  fi
  [ -n "${AWS_REGION:-}" ] && export AWS_DEFAULT_REGION="$AWS_REGION"
  # The CLI must never prompt or page.
  export AWS_PAGER=""
  return 0
}

# ── Retention tiers (INFRA.md §3.5) ───────────────────────────────────────────

# ms_backup_tier [epoch]: monthly on the 1st (UTC), weekly on a Sunday,
# daily otherwise. The lifecycle expires daily/weekly/monthly objects after
# 14/56/365 days by the `tier` tag.
ms_backup_tier() {
  local now="${1:-$(date +%s)}" dom dow
  dom="$(date -u -d "@$now" +%-d)"
  dow="$(date -u -d "@$now" +%w)"
  if [ "$dom" = "1" ]; then printf 'monthly'
  elif [ "$dow" = "0" ]; then printf 'weekly'
  else printf 'daily'; fi
}

# ms_retain_until <tier> [epoch]: ISO-8601 UTC date of the per-object
# GOVERNANCE lock (weekly 56 d, monthly 365 d); empty for daily (the bucket
# default of 14 d applies).
ms_retain_until() {
  local tier="$1" now="${2:-$(date +%s)}" days
  case "$tier" in
    weekly) days=56 ;;
    monthly) days=365 ;;
    *) return 0 ;;
  esac
  date -u -d "@$((now + days * 86400))" +%Y-%m-%dT%H:%M:%SZ
}

# ms_sha256_b64 <file>: base64 of the raw SHA-256 (the PutObject
# `x-amz-checksum-sha256` value; S3 refuses a body that does not match).
ms_sha256_b64() {
  sha256sum "$1" | cut -d' ' -f1 | xxd -r -p | base64 -w0
}

# ── DATABASE_URL ──────────────────────────────────────────────────────────────

# Percent-decoding (`%40` → `@`, `+` stays `+` as libpq expects).
ms_urldecode() {
  local s="$1"
  printf '%b' "${s//%/\\x}"
}

# Fills DB_USER DB_PASS DB_HOST DB_PORT DB_NAME and exports PGSSLMODE when
# the URL carries sslmode. Accepts postgres:// and postgresql://.
ms_parse_db_url() {
  local url="$1" query="" rest auth hostport kv
  [ -n "$url" ] || return 1
  case "$url" in
    *\?*)
      query="${url#*\?}"
      url="${url%%\?*}"
      ;;
  esac
  rest="${url#*://}"
  if [[ "$rest" == *@* ]]; then
    auth="${rest%@*}"
    rest="${rest##*@}"
  else
    auth=""
  fi
  if [[ "$auth" == *:* ]]; then
    DB_USER="$(ms_urldecode "${auth%%:*}")"
    DB_PASS="$(ms_urldecode "${auth#*:}")"
  else
    DB_USER="$(ms_urldecode "$auth")"
    DB_PASS=""
  fi
  hostport="${rest%%/*}"
  DB_NAME="${rest#*/}"
  DB_NAME="$(ms_urldecode "${DB_NAME%%/*}")"
  if [[ "$hostport" == *:* ]]; then
    DB_HOST="${hostport%%:*}"
    DB_PORT="${hostport##*:}"
  else
    DB_HOST="$hostport"
    DB_PORT=5432
  fi
  [ -n "$DB_HOST" ] || DB_HOST=localhost
  if [ -n "$query" ]; then
    for kv in ${query//&/ }; do
      case "$kv" in
        sslmode=*) export PGSSLMODE="${kv#sslmode=}" ;;
      esac
    done
  fi
  [ -n "$DB_NAME" ] && [ -n "$DB_USER" ]
}

# pgpass field escaping: `\` → `\\`, `:` → `\:`.
ms_pgpass_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//:/\\:}"
  printf '%s' "$s"
}

# Writes `<host>:<port>:*:<user>:<password>` to <dir>/pgpass (0600) and
# exports PGPASSFILE. `*` for the database so createdb / a scratch database
# work with the same file.
ms_write_pgpass() {
  local dir="$1" file="$1/pgpass"
  (
    umask 077
    printf '%s:%s:*:%s:%s\n' \
      "$DB_HOST" "$DB_PORT" "$(ms_pgpass_escape "$DB_USER")" "$(ms_pgpass_escape "$DB_PASS")" \
      >"$file"
  )
  chmod 600 "$file"
  export PGPASSFILE="$file"
}

# Common libpq connection arguments (no password, no URL).
ms_pg_args() {
  printf '%s\n' -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER"
}

# ── Misc ──────────────────────────────────────────────────────────────────────

ms_require_tool() {
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || ms_die 2 "required tool not found on PATH: $t"
  done
}

ms_sha256() {
  sha256sum "$1" | cut -d' ' -f1
}

ms_size() {
  stat -c %s "$1"
}

ms_human() {
  numfmt --to=iec --suffix=B "$1" 2>/dev/null || printf '%sB' "$1"
}
