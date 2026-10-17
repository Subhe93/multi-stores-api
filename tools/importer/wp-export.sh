#!/usr/bin/env bash
# =============================================================================
# wp-export.sh - read-only WooCommerce catalog export ("WordPress export
# bundle" v1, M4.4 section 2.1) for the multi-stores importer.
#
# Run it on the WordPress server, as the site owner, from the WordPress root
# (or pass --path). It needs WP-CLI and the PHP CLI that WP-CLI uses.
#
#   bash wp-export.sh                       # export, self-check, package
#   bash wp-export.sh --path ~/public_html  # WordPress root elsewhere
#   bash wp-export.sh --check DIR           # only re-run the privacy self-check
#   bash wp-export.sh --help
#
# Guarantees:
#   * Read-only. Every SQL statement goes through wpx_query, which refuses
#     anything that is not a single SELECT / SHOW statement. The only other
#     WP-CLI calls are `db prefix`, `core version`, `option get` (two Rank Math
#     options, filtered to an allowlist of sub-keys before they are written)
#     and `plugin list`. WordPress always runs with --skip-plugins
#     --skip-themes, so no plugin code is loaded (some security plugins rewrite
#     .htaccess when loaded).
#   * Strict allowlist. Only catalog post types, product taxonomies,
#     WooCommerce attribute / shipping / tax tables, the PPOM field table and
#     a fixed list of options are read. Users, usermeta, orders (posts and
#     HPOS), comments, sessions, API keys, payment-gateway settings and
#     wp-config are never queried.
#   * Every WHERE condition is parenthesised.
#   * Before packaging, wpx_scan_forbidden scans every produced file for
#     secret-like names and (in settings files) e-mail addresses, checks the
#     post types and the file names, and refuses to package on any hit.
#     Values are never printed, only file names and line numbers.
#
# Output (next to each other, by default in $HOME, never in the web root):
#   <host>-export-<yyyymmdd>/       the plain bundle directory
#   <host>-export-<yyyymmdd>.tgz    the same files, flat archive
# =============================================================================
set -euo pipefail
# Byte-based text tools: the self-check must see every byte of every file.
# Under a UTF-8 locale GNU grep treats a line with an invalid byte as binary
# and stops reporting lines ("Binary file ... matches"), which would let a
# secret pass. With LC_ALL=C grep, awk, sed, sort and tr work on bytes.
export LC_ALL=C

WPX_FORMAT_VERSION=1
WPX_GENERATOR="multi-stores wp-export.sh 1.0.0"

# Post types of the catalog (products, variations, NPP templates, ACF fields).
WPX_POST_TYPES="'product','product_variation','npp_template','acf-field-group','acf-field'"
WPX_EXCLUDED_STATUSES="'trash','auto-draft','inherit'"
# Product taxonomies (plus the attribute taxonomies pa_*).
WPX_TAXONOMIES="'product_cat','product_tag','product_type','product_visibility','product_shipping_class'"

# Options exported as-is. Must stay a subset of OPTION_ALLOWLIST in
# src/modules/importer/adapters/wp-bundle/bundle-schema.ts (checked by
# wp-export-format.spec.ts). The two Rank Math options with personal data are
# NOT in this list; they are filtered by key below.
WPX_OPTIONS=(
  siteurl
  home
  blogname
  WPLANG
  permalink_structure
  woocommerce_permalinks
  woocommerce_currency
  woocommerce_price_num_decimals
  woocommerce_prices_include_tax
  woocommerce_calc_taxes
  woocommerce_tax_based_on
  woocommerce_default_country
  woocommerce_weight_unit
  woocommerce_dimension_unit
  woocommerce_allowed_countries
  woocommerce_specific_allowed_countries
  woocommerce_ship_to_countries
  woocommerce_specific_ship_to_countries
  woocommerce_shipping_cost_requires_address
  wc_hide_shipping_options
  npp_display
  npp_sale
  npp_welcome_template_ids
  rank_math_modules
  rank-math-options-sitemap
  woo_variation_swatches
)

# Sub-keys kept from rank-math-options-general (console_email_* etc. dropped).
# Same list as RANK_MATH_GENERAL_ALLOWED_KEYS in bundle-schema.ts.
WPX_RANK_MATH_GENERAL_KEYS=(
  wc_remove_product_base
  wc_remove_category_base
  wc_remove_category_parent_slugs
  strip_category_base
  noindex_hidden_products
  attachment_redirect_urls
)

# Sub-keys kept from rank-math-options-titles (knowledge-graph name, phone,
# e-mail, address and social profiles dropped). These are the keys the
# importer reads (detectors/rank-math.ts) plus their siblings.
WPX_RANK_MATH_TITLES_KEYS=(
  noindex_empty_taxonomies
  pt_product_title
  pt_product_description
  tax_product_cat_title
  tax_product_cat_description
  tax_product_tag_title
  tax_product_tag_description
  title_separator
  website_name
)

# Every file name a bundle may contain (BUNDLE_FILE_ALLOWLIST in bundle-schema.ts).
WPX_BUNDLE_FILES=(
  manifest.json
  posts.tsv
  postmeta.tsv
  terms.tsv
  term_taxonomy.tsv
  termmeta.tsv
  term_relationships.tsv
  attribute_taxonomies.tsv
  attachments.tsv
  options.tsv
  ppom_meta.tsv
  shipping_zones.tsv
  shipping_zone_locations.tsv
  shipping_zone_methods.tsv
  tax_rates.tsv
  tax_rate_locations.tsv
  plugins.csv
  versions.txt
)

# Secret-like names, checked in every file (header rows excluded).
WPX_SECRET_RE='consumer_(key|secret)|oauth|access_?token|refresh_?token|client_secret|api[_-]?key|secret[_-]?key|private[_-]?key|passw(or)?d|user_pass|user_email|user_login|session_tokens|billing_(email|phone)|shipping_phone|_customer_user|sk_live_|pk_live_|rk_live_|whsec_|(ck|cs)_[0-9a-f]{40}'
# E-mail shapes, checked in the settings-like files only (product texts may
# legitimately show a shop address).
WPX_EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
WPX_EMAIL_FILES_RE='^(manifest\.json|options\.tsv|shipping_[a-z_]+\.tsv|tax_[a-z_]+\.tsv|attribute_taxonomies\.tsv|plugins\.csv|versions\.txt)$'
# Key-like secret names (licence keys, purchase codes, tokens, webhooks).
# Too common in product texts ("text-token-..." class names, "license" in a
# description) to scan everywhere: checked in the settings-like files and in
# the non-content rows of postmeta.tsv / termmeta.tsv (key and value).
WPX_SECRET_KEY_RE='licen[cs]e|purchase_?code|token|webhook'
WPX_SECRET_KEY_FILES_RE='^(options\.tsv|shipping_[a-z_]+\.tsv|tax_[a-z_]+\.tsv)$'
# Meta keys whose values are product content (texts shown in the shop); the
# e-mail and key-like checks skip them. Everything else in postmeta/termmeta
# is settings-like and must not carry an e-mail address.
WPX_CONTENT_META_KEY_RE='^_?(rank_math_(title|description|focus_keyword|facebook_title|facebook_description|twitter_title|twitter_description)|_variation_description|_purchase_note|_product_attributes|product_[a-z0-9_]+|fb_[a-z0-9_]*description|hint_[0-9]+|description|label|extra)$'
# The same e-mail shape for awk (no {n,} intervals, no backslash escapes).
WPX_EMAIL_AWK_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+([.][A-Za-z0-9-]+)*[.][A-Za-z][A-Za-z]+'

# Upload limits of the importer API (BUNDLE_UPLOAD_MAX_FILE_BYTES and
# BUNDLE_UPLOAD_MAX_BYTES in src/modules/importer/runs/bundle-store.ts):
# 40 MB per file, 50 MB for the whole bundle. The summary warns above them.
# (The environment overrides exist for the offline tests only.)
WPX_MAX_FILE_BYTES=${WPX_MAX_FILE_BYTES:-$((40 * 1024 * 1024))}
WPX_MAX_TOTAL_BYTES=${WPX_MAX_TOTAL_BYTES:-$((50 * 1024 * 1024))}

# Shipping methods whose instance options (woocommerce_<method>_<n>_settings)
# are exported by default: the WooCommerce core methods, whose settings are
# title / cost / tax status / requirements only. Any other method (carrier
# plugins: DHL, PostNord, UPS, ...) may keep API credentials in the same
# option and is left out unless named with --include-method.
WPX_SHIPPING_METHODS_DEFAULT="flat_rate free_shipping local_pickup"

# Self-check hits accepted with --allow FILE:LINE (still printed, not counted).
WPX_ALLOW=()

wpx_log() { printf '%s\n' "$*" >&2; }
wpx_die() {
  printf 'wp-export: ERROR: %s\n' "$*" >&2
  exit 1
}

# wpx_in_list NEEDLE [WORD...]: 0 when NEEDLE is one of the words.
wpx_in_list() {
  local needle=$1 w
  shift
  for w in "$@"; do
    [ "$w" = "$needle" ] && return 0
  done
  return 1
}

wpx_is_bundle_file() {
  local name=$1 f
  for f in "${WPX_BUNDLE_FILES[@]}"; do
    [ "$f" = "$name" ] && return 0
  done
  return 1
}

# -----------------------------------------------------------------------------
# Privacy self-check. Usage: wpx_scan_forbidden DIR
# Prints one line per problem (file and line number only, never the value)
# and returns 1 when anything was found, 0 when the directory is clean.
# A hit listed in WPX_ALLOW (--allow FILE:LINE) is still printed, marked as
# allowed, and not counted.
# Every grep runs with -a (and LC_ALL=C, see the top): a data row with an
# invalid UTF-8 byte is scanned like any other, never skipped as "binary".
# -----------------------------------------------------------------------------
wpx_scan_hit() { # wpx_scan_hit FILE LINE "message" (uses the caller's $problems)
  if wpx_in_list "$1:$2" ${WPX_ALLOW[@]+"${WPX_ALLOW[@]}"}; then
    printf 'self-check: %s line %d %s (allowed by --allow %s:%d)\n' "$1" "$2" "$3" "$1" "$2"
  else
    printf 'self-check: %s line %d %s\n' "$1" "$2" "$3"
    problems=$((problems + 1))
  fi
}

wpx_scan_forbidden() {
  local dir=$1 problems=0 f base start lines n kind key
  [ -d "$dir" ] || {
    printf 'self-check: %s is not a directory\n' "$dir"
    return 1
  }
  for f in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    base=${f##*/}
    if [ -L "$f" ] || [ ! -f "$f" ]; then
      printf 'self-check: %s is not a regular file\n' "$base"
      problems=$((problems + 1))
      continue
    fi
    if ! wpx_is_bundle_file "$base"; then
      printf 'self-check: unexpected file %s (not in the bundle allowlist)\n' "$base"
      problems=$((problems + 1))
      continue
    fi
    # TSV/CSV files start with a header row of column names (post_password is
    # one of them); only data rows are scanned.
    start=1
    case $base in *.tsv | *.csv) start=2 ;; esac

    # Secret-like names. In posts.tsv the product texts (post_content 5,
    # post_excerpt 7, post_content_filtered 17) are blanked first: a
    # description that says "password" or "API key" is not a secret; the
    # title, slug, guid and the other columns are still scanned.
    if [ "$base" = posts.tsv ]; then
      lines=$(awk -F '\t' 'BEGIN { OFS = "\t" } NR > 1 { $5 = ""; $7 = ""; $17 = ""; print }' "$f" |
        grep -naiE -- "$WPX_SECRET_RE" | cut -d: -f1 | head -n 5 || true)
    else
      lines=$(tail -n +"$start" "$f" | grep -naiE -- "$WPX_SECRET_RE" | cut -d: -f1 | head -n 5 || true)
    fi
    for n in $lines; do
      wpx_scan_hit "$base" $((n + start - 1)) "contains a secret-like name"
    done

    if printf '%s\n' "$base" | grep -qaE "$WPX_EMAIL_FILES_RE"; then
      lines=$(tail -n +"$start" "$f" | grep -naE -- "$WPX_EMAIL_RE" | cut -d: -f1 | head -n 5 || true)
      for n in $lines; do
        if [ "$base" = options.tsv ]; then
          wpx_scan_hit "$base" $((n + start - 1)) \
            "(option $(sed -n "$((n + start - 1))p" "$f" | cut -f1 | tr -cd 'A-Za-z0-9_.-')) contains an e-mail address"
        else
          wpx_scan_hit "$base" $((n + start - 1)) "contains an e-mail address"
        fi
      done
    fi

    if printf '%s\n' "$base" | grep -qaE "$WPX_SECRET_KEY_FILES_RE"; then
      lines=$(tail -n +"$start" "$f" | grep -naiE -- "$WPX_SECRET_KEY_RE" | cut -d: -f1 | head -n 5 || true)
      for n in $lines; do
        wpx_scan_hit "$base" $((n + start - 1)) "contains a secret-like name"
      done
    fi

    # postmeta/termmeta (meta_id, object_id, meta_key, meta_value): e-mail
    # addresses and key-like secret names outside the product content keys.
    # Reports the line and meta key, never the value.
    if [ "$base" = postmeta.tsv ] || [ "$base" = termmeta.tsv ]; then
      lines=$(awk -F '\t' -v content="$WPX_CONTENT_META_KEY_RE" -v mail="$WPX_EMAIL_AWK_RE" -v secret="$WPX_SECRET_KEY_RE" '
        NR > 1 {
          key = tolower($3)
          if (key ~ content) next
          if ($4 ~ mail) { print NR ":mail:" $3; next }
          if (key ~ secret || tolower($4) ~ secret) print NR ":secret:" $3
        }' "$f" | head -n 5 || true)
      if [ -n "$lines" ]; then
        while IFS=: read -r n kind key; do
          [ -n "$n" ] || continue
          key=$(printf '%s' "$key" | tr -cd 'A-Za-z0-9_.-')
          if [ "$kind" = mail ]; then
            wpx_scan_hit "$base" "$n" "(meta $key) contains an e-mail address"
          else
            wpx_scan_hit "$base" "$n" "(meta $key) contains a secret-like name"
          fi
        done <<<"$lines"
      fi
    fi

    # attachments.tsv: image_meta (camera, credit, copyright) is stripped by
    # the export; a row that still has it was not produced by this script.
    if [ "$base" = attachments.tsv ]; then
      lines=$(tail -n +2 "$f" | grep -naF 's:10:"image_meta"' | cut -d: -f1 | head -n 5 || true)
      for n in $lines; do
        wpx_scan_hit "$base" $((n + 1)) "still has image_meta (camera/credit/copyright)"
      done
    fi

    # posts.tsv: only catalog post types (column 21 = post_type).
    if [ "$base" = posts.tsv ]; then
      lines=$(awk -F '\t' 'NR > 1 && $21 !~ /^(product|product_variation|npp_template|acf-field-group|acf-field)$/ { print NR }' "$f" | head -n 5 || true)
      for n in $lines; do
        wpx_scan_hit "$base" "$n" "has a post type outside the catalog allowlist"
      done
    fi
  done
  [ "$problems" -eq 0 ]
}

# -----------------------------------------------------------------------------
# WP-CLI helpers
# -----------------------------------------------------------------------------
WPX_WP=(wp)
WPX_PHP=php
WPX_PATH=""
WPX_PREFIX=""
WPX_OUT=""

wpx_wp() {
  if [ -n "$WPX_PATH" ]; then
    "${WPX_WP[@]}" --skip-plugins --skip-themes --path="$WPX_PATH" "$@"
  else
    "${WPX_WP[@]}" --skip-plugins --skip-themes "$@"
  fi
}

# Refuses anything but one SELECT / SHOW statement (defence in depth: the SQL
# in this file is fixed, but a typo must never become a write).
wpx_assert_read_only_sql() {
  local sql=$1 first
  first=$(printf '%s' "$sql" | tr '\n\t\r' '   ' | sed -E 's/^ +//' | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')
  case $first in
    SELECT | SHOW) ;;
    *) wpx_die "refusing non-read-only SQL (starts with '$first')" ;;
  esac
  case $sql in *';'*) wpx_die "refusing SQL with ';' (one statement only)" ;; esac
  if printf '%s' "$sql" | grep -qiwE 'INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|CALL|HANDLER|LOAD|OUTFILE|DUMPFILE|SET|DO|PREPARE|EXECUTE'; then
    wpx_die "refusing SQL with a write or session keyword"
  fi
}

# wpx_query SQL [extra wp db query args...] -> mysql batch output on stdout.
# Output goes to a file or a pipe, so the mysql client prints batch format:
# TAB-separated, \t \n \\ \0 escaped, NULL as the bare word NULL.
# `wp db query` forwards unknown --flags to the mysql client (that is how
# --skip-column-names reaches it too): --default-character-set=utf8mb4 makes
# the client return the bytes as stored (DB_CHARSET is usually utf8mb4, but
# an old wp-config.php may say utf8 or nothing, which would mangle emoji
# and 4-byte characters), --quick streams rows instead of buffering the
# whole result in the client's memory (shared hosting memory limits).
wpx_query() {
  local sql=$1
  shift
  wpx_assert_read_only_sql "$sql"
  wpx_wp db query "$sql" --default-character-set=utf8mb4 --quick "$@"
}

# One value (first column of the first row), or empty.
wpx_scalar() {
  wpx_query "$1" --skip-column-names | head -n 1 | tr -d '\r'
}

# wpx_show_nonempty WHAT SQL: 0 when the SHOW statement returns a row, 1 when
# it returns nothing. A failed query (no database, bad credentials, a typo)
# is neither: it stops the export with the first error line, so a table is
# never silently treated as absent.
wpx_show_nonempty() {
  local what=$1 sql=$2 out err="${WPX_OUT:-.}/.err"
  out=$(wpx_query "$sql" --skip-column-names 2>"$err") || {
    wpx_log "query failed while checking $what: $(head -n 1 "$err" 2>/dev/null)"
    rm -f "$err"
    wpx_die "could not check $what (the query failed); nothing was exported"
  }
  rm -f "$err"
  [ -n "$(printf '%s' "$out" | tr -d '\r\n ')" ]
}

wpx_table_exists() {
  local like=${1//_/\\_}
  wpx_show_nonempty "table $1" "SHOW TABLES LIKE '${like}'"
}

wpx_column_exists() {
  local table=$1 column=$2
  wpx_show_nonempty "column $1.$2" "SHOW COLUMNS FROM \`${table}\` LIKE '${column//_/\\_}'"
}

# EXIT trap: the temporary files of an interrupted run never stay in the
# bundle directory (they would fail the self-check of a later --check, and
# .err may hold a mysql error message).
wpx_cleanup() {
  [ -n "$WPX_OUT" ] && [ -d "$WPX_OUT" ] || return 0
  rm -f "$WPX_OUT"/*.part "$WPX_OUT/.err"
}

# wpx_emit_table FILE "col1 col2 ..." SQL
# Runs the SELECT with a header row, writes FILE, and checks that the header
# is exactly the expected column list. An empty result still gets the header.
wpx_emit_table() {
  local file=$1 columns=$2 sql=$3 header got
  header=$(printf '%s' "$columns" | tr ' ' '\t')
  if ! wpx_query "$sql" >"$WPX_OUT/$file.part" 2>"$WPX_OUT/.err"; then
    wpx_log "query for $file failed: $(head -n 1 "$WPX_OUT/.err" 2>/dev/null)"
    rm -f "$WPX_OUT/$file.part" "$WPX_OUT/.err"
    wpx_die "export of $file failed"
  fi
  rm -f "$WPX_OUT/.err"
  if [ ! -s "$WPX_OUT/$file.part" ]; then
    printf '%s\n' "$header" >"$WPX_OUT/$file.part"
  fi
  got=$(head -n 1 "$WPX_OUT/$file.part" | tr -d '\r')
  if [ "$got" != "$header" ]; then
    rm -f "$WPX_OUT/$file.part"
    wpx_die "$file: unexpected header row (expected: $columns)"
  fi
  mv "$WPX_OUT/$file.part" "$WPX_OUT/$file"
}

# Reads one option as JSON through WP-CLI and keeps only the given scalar
# sub-keys, re-serialized as PHP and escaped for the TSV (\\ \t \n \0).
# Prints nothing (and logs a note) when the option does not exist or is not
# an array.
wpx_filtered_option() {
  local name=$1 json
  shift
  json=$(wpx_wp option get "$name" --format=json 2>/dev/null) || {
    wpx_log "note: option $name does not exist (or could not be read); not exported"
    return 0
  }
  [ -n "$json" ] || {
    wpx_log "note: option $name is empty; not exported"
    return 0
  }
  # shellcheck disable=SC2016 # PHP code, not shell expansions.
  printf '%s' "$json" | "$WPX_PHP" -r '
    $name = $argv[1];
    $keys = array_slice($argv, 2);
    $v = json_decode(stream_get_contents(STDIN), true);
    if (!is_array($v)) { fwrite(STDERR, "note: option " . $name . " is not an array; not exported\n"); exit(0); }
    $o = array();
    foreach ($keys as $k) {
      if (array_key_exists($k, $v) && (is_string($v[$k]) || is_int($v[$k]) || is_bool($v[$k]))) { $o[$k] = $v[$k]; }
    }
    echo strtr(serialize($o), array("\\" => "\\\\", "\t" => "\\t", "\n" => "\\n", "\0" => "\\0"));
  ' -- "$name" "$@"
}

# Removes `image_meta` (camera, credit, copyright, caption, keywords) from
# `_wp_attachment_metadata` (column 6) of attachments.tsv in place. Rows
# without it stay byte-identical; a value that does not unserialize but
# mentions image_meta is replaced by NULL.
wpx_strip_image_meta() {
  local file=$1
  # shellcheck disable=SC2016 # PHP code, not shell expansions.
  "$WPX_PHP" -r '
    $unesc = function ($s) { return strtr($s, array("\\\\" => "\\", "\\t" => "\t", "\\n" => "\n", "\\0" => "\0")); };
    $esc = function ($s) { return strtr($s, array("\\" => "\\\\", "\t" => "\\t", "\n" => "\\n", "\0" => "\\0")); };
    $first = true;
    while (($line = fgets(STDIN)) !== false) {
      if ($first) { $first = false; echo $line; continue; }
      $eol = substr($line, -1) === "\n" ? "\n" : "";
      $cols = explode("\t", rtrim($line, "\n"));
      if (isset($cols[5]) && strpos($cols[5], "image_meta") !== false) {
        $v = @unserialize($unesc($cols[5]), array("allowed_classes" => false));
        if (is_array($v)) { unset($v["image_meta"]); $cols[5] = $esc(serialize($v)); }
        else { $cols[5] = "NULL"; }
        $line = implode("\t", $cols) . $eol;
      }
      echo $line;
    }
  ' <"$file" >"$file.part" || {
    rm -f "$file.part"
    wpx_die "could not filter $(basename "$file")"
  }
  mv "$file.part" "$file"
}

wpx_usage() {
  sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Options:
  --path DIR           WordPress root (default: current directory)
  --out DIR            output directory outside the web root
                       (default: ~/<host>-export-<yyyymmdd>);
                       must not exist or be empty
  --wp "CMD"           WP-CLI command (default: wp), e.g. --wp "wp --allow-root"
  --php CMD            PHP CLI used to filter two Rank Math options (default: php)
  --skip-option NAME   leave one allowlisted option out (repeatable); it can
                       only remove options, never add any
  --include-method ID  also export the instance settings of a non-core
                       shipping method (repeatable), e.g. --include-method
                       dhl_express; by default only flat_rate, free_shipping
                       and local_pickup settings are exported
  --allow FILE:LINE    accept one self-check hit you have reviewed as a false
                       positive (repeatable), e.g. --allow posts.tsv:12; the
                       hit is still printed
  --no-archive         do not create the .tgz (the directory is always kept)
  --no-plugin-list     do not write plugins.csv
  --check DIR          only run the privacy self-check on an existing bundle
  -h, --help           this help
EOF
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
wpx_main() {
  local out="" archive=1 plugin_list=1 check_dir="" skip_options=() include_methods=()
  while [ $# -gt 0 ]; do
    case $1 in
      --path) WPX_PATH=${2:?--path needs a directory}; shift 2 ;;
      --out) out=${2:?--out needs a directory}; shift 2 ;;
      --wp) read -r -a WPX_WP <<<"${2:?--wp needs a command}"; shift 2 ;;
      --php) WPX_PHP=${2:?--php needs a command}; shift 2 ;;
      --skip-option) skip_options+=("${2:?--skip-option needs a name}"); shift 2 ;;
      --include-method)
        printf '%s' "${2:?--include-method needs a method id}" | grep -qaE '^[a-z0-9_]+$' ||
          wpx_die "--include-method: a method id is lower-case letters, digits and _ (e.g. dhl_express)"
        include_methods+=("$2")
        shift 2 ;;
      --allow)
        printf '%s' "${2:?--allow needs FILE:LINE}" | grep -qaE '^[a-z_]+\.(tsv|csv|json|txt):[0-9]+$' ||
          wpx_die "--allow: expected FILE:LINE as printed by the self-check (e.g. posts.tsv:12)"
        WPX_ALLOW+=("$2")
        shift 2 ;;
      --no-archive) archive=0; shift ;;
      --no-plugin-list) plugin_list=0; shift ;;
      --check) check_dir=${2:?--check needs a directory}; shift 2 ;;
      -h | --help) wpx_usage; return 0 ;;
      *) wpx_die "unknown argument: $1 (see --help)" ;;
    esac
  done

  if [ -n "$check_dir" ]; then
    if wpx_scan_forbidden "$check_dir"; then
      wpx_log "self-check: OK ($check_dir)"
      return 0
    fi
    wpx_die "self-check failed for $check_dir"
  fi

  command -v "${WPX_WP[0]}" >/dev/null 2>&1 || wpx_die "WP-CLI not found ('${WPX_WP[0]}'); see README.md"
  command -v "$WPX_PHP" >/dev/null 2>&1 || wpx_die "PHP CLI not found ('$WPX_PHP'); pass --php"
  command -v tar >/dev/null 2>&1 || [ "$archive" -eq 0 ] || wpx_die "tar not found; use --no-archive"

  umask 077

  WPX_PREFIX=$(wpx_wp db prefix | tr -d '\r\n')
  printf '%s' "$WPX_PREFIX" | grep -qE '^[A-Za-z0-9_]+$' || wpx_die "unexpected table prefix"
  local P=$WPX_PREFIX

  local site_url home_url host wp_version wc_version locale
  site_url=$(wpx_scalar "SELECT option_value FROM ${P}options WHERE ( option_name = 'siteurl' )")
  home_url=$(wpx_scalar "SELECT option_value FROM ${P}options WHERE ( option_name = 'home' )")
  wc_version=$(wpx_scalar "SELECT option_value FROM ${P}options WHERE ( option_name = 'woocommerce_version' )")
  locale=$(wpx_scalar "SELECT option_value FROM ${P}options WHERE ( option_name = 'WPLANG' )")
  wp_version=$(wpx_wp core version 2>/dev/null | tr -d '\r\n' || true)
  host=$(printf '%s' "${home_url:-$site_url}" | sed -E 's#^[A-Za-z]+://##; s#[/:?].*$##' | tr '[:upper:]' '[:lower:]')
  printf '%s' "$host" | grep -qE '^[a-z0-9.-]+$' || wpx_die "could not read the site host from siteurl/home"
  [ -n "$wc_version" ] || wpx_die "WooCommerce does not seem to be installed (no woocommerce_version option)"

  # Default: the home directory, never the web root (the bundle must not be
  # downloadable over HTTP).
  out=${out:-${HOME:-.}/${host}-export-$(date -u +%Y%m%d)}
  if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then
    wpx_die "output directory $out exists and is not empty"
  fi
  local wp_root
  wp_root=$(cd "${WPX_PATH:-.}" && pwd -P)
  mkdir -p "$out"
  chmod 700 "$out"
  WPX_OUT=$(cd "$out" && pwd -P)
  trap wpx_cleanup EXIT
  case "$WPX_OUT/" in
    "$wp_root"/*)
      rmdir "$WPX_OUT" 2>/dev/null || true
      wpx_die "refusing to write inside the WordPress root ($wp_root); use --out with a directory outside it"
      ;;
  esac
  wpx_log "exporting ${host} (prefix ${P}) to ${WPX_OUT}"

  local exported_posts exported_products product_tt product_terms
  exported_posts="SELECT ep.ID FROM ${P}posts ep WHERE ( ep.post_type IN (${WPX_POST_TYPES}) ) AND ( ep.post_status NOT IN (${WPX_EXCLUDED_STATUSES}) )"
  # Only products and variations carry _product_image_gallery.
  exported_products="SELECT epr.ID FROM ${P}posts epr WHERE ( epr.post_type IN ('product','product_variation') ) AND ( epr.post_status NOT IN (${WPX_EXCLUDED_STATUSES}) )"
  product_tt="SELECT ptt.term_taxonomy_id FROM ${P}term_taxonomy ptt WHERE ( ptt.taxonomy IN (${WPX_TAXONOMIES}) OR ptt.taxonomy LIKE 'pa\\_%' )"
  product_terms="SELECT ptm.term_id FROM ${P}term_taxonomy ptm WHERE ( ptm.taxonomy IN (${WPX_TAXONOMIES}) OR ptm.taxonomy LIKE 'pa\\_%' )"

  # --- posts: the 23 wp_posts columns; post_author zeroed (user id),
  #     post_password blanked (a secret).
  wpx_emit_table posts.tsv \
    "ID post_author post_date post_date_gmt post_content post_title post_excerpt post_status comment_status ping_status post_password post_name to_ping pinged post_modified post_modified_gmt post_content_filtered post_parent guid menu_order post_type post_mime_type comment_count" \
    "SELECT p.ID, 0 AS post_author, p.post_date, p.post_date_gmt, p.post_content, p.post_title, p.post_excerpt, p.post_status, p.comment_status, p.ping_status, '' AS post_password, p.post_name, p.to_ping, p.pinged, p.post_modified, p.post_modified_gmt, p.post_content_filtered, p.post_parent, p.guid, p.menu_order, p.post_type, p.post_mime_type, p.comment_count
     FROM ${P}posts p
     WHERE ( p.post_type IN (${WPX_POST_TYPES}) ) AND ( p.post_status NOT IN (${WPX_EXCLUDED_STATUSES}) )
     ORDER BY p.ID"

  # --- postmeta of those posts, without the _edit_lock / _edit_last user ids.
  wpx_emit_table postmeta.tsv "meta_id post_id meta_key meta_value" \
    "SELECT pm.meta_id, pm.post_id, pm.meta_key, pm.meta_value
     FROM ${P}postmeta pm
     WHERE ( pm.post_id IN (${exported_posts}) ) AND ( pm.meta_key NOT LIKE '\\_edit\\_%' )
     ORDER BY pm.meta_id"

  # --- product taxonomies.
  local term_cols="term_id name slug term_group" term_select="t.term_id, t.name, t.slug, t.term_group"
  if wpx_column_exists "${P}terms" term_order; then
    term_cols="$term_cols term_order"
    term_select="$term_select, t.term_order"
  fi
  wpx_emit_table terms.tsv "$term_cols" \
    "SELECT ${term_select} FROM ${P}terms t WHERE ( t.term_id IN (${product_terms}) ) ORDER BY t.term_id"

  wpx_emit_table term_taxonomy.tsv "term_taxonomy_id term_id taxonomy description parent count" \
    "SELECT tt.term_taxonomy_id, tt.term_id, tt.taxonomy, tt.description, tt.parent, tt.count
     FROM ${P}term_taxonomy tt
     WHERE ( tt.taxonomy IN (${WPX_TAXONOMIES}) OR tt.taxonomy LIKE 'pa\\_%' )
     ORDER BY tt.term_taxonomy_id"

  wpx_emit_table termmeta.tsv "meta_id term_id meta_key meta_value" \
    "SELECT tm.meta_id, tm.term_id, tm.meta_key, tm.meta_value
     FROM ${P}termmeta tm
     WHERE ( tm.term_id IN (${product_terms}) )
     ORDER BY tm.meta_id"

  wpx_emit_table term_relationships.tsv "object_id term_taxonomy_id term_order" \
    "SELECT tr.object_id, tr.term_taxonomy_id, tr.term_order
     FROM ${P}term_relationships tr
     WHERE ( tr.object_id IN (${exported_posts}) ) AND ( tr.term_taxonomy_id IN (${product_tt}) )
     ORDER BY tr.object_id, tr.term_taxonomy_id"

  # --- WooCommerce attribute taxonomies.
  wpx_emit_table attribute_taxonomies.tsv "attribute_id attribute_name attribute_label attribute_type attribute_orderby attribute_public" \
    "SELECT wat.attribute_id, wat.attribute_name, wat.attribute_label, wat.attribute_type, wat.attribute_orderby, wat.attribute_public
     FROM ${P}woocommerce_attribute_taxonomies wat
     ORDER BY wat.attribute_id"

  # --- attachments: children of exported posts, or referenced by
  #     _thumbnail_id, _product_image_gallery, or term thumbnails / swatches.
  #     The gallery test is a correlated EXISTS (FIND_IN_SET over a comma
  #     list), evaluated once per candidate attachment: it is restricted to
  #     non-empty gallery rows of exported products / variations so that the
  #     inner scan stays small on big uploads tables.
  wpx_emit_table attachments.tsv "ID guid post_mime_type post_parent _wp_attached_file _wp_attachment_metadata _wp_attachment_image_alt" \
    "SELECT a.ID, a.guid, a.post_mime_type, a.post_parent,
       (SELECT m1.meta_value FROM ${P}postmeta m1 WHERE ( m1.post_id = a.ID ) AND ( m1.meta_key = '_wp_attached_file' ) ORDER BY m1.meta_id LIMIT 1) AS _wp_attached_file,
       (SELECT m2.meta_value FROM ${P}postmeta m2 WHERE ( m2.post_id = a.ID ) AND ( m2.meta_key = '_wp_attachment_metadata' ) ORDER BY m2.meta_id LIMIT 1) AS _wp_attachment_metadata,
       (SELECT m3.meta_value FROM ${P}postmeta m3 WHERE ( m3.post_id = a.ID ) AND ( m3.meta_key = '_wp_attachment_image_alt' ) ORDER BY m3.meta_id LIMIT 1) AS _wp_attachment_image_alt
     FROM ${P}posts a
     WHERE ( a.post_type = 'attachment' )
       AND ( a.post_status <> 'trash' )
       AND (
            ( a.post_parent IN (${exported_posts}) )
         OR ( a.ID IN (SELECT CAST(th.meta_value AS UNSIGNED) FROM ${P}postmeta th WHERE ( th.meta_key = '_thumbnail_id' ) AND ( th.post_id IN (${exported_posts}) )) )
         OR ( EXISTS (SELECT 1 FROM ${P}postmeta g WHERE ( g.meta_key = '_product_image_gallery' ) AND ( g.meta_value <> '' ) AND ( g.post_id IN (${exported_products}) ) AND ( FIND_IN_SET(a.ID, g.meta_value) > 0 )) )
         OR ( a.ID IN (SELECT CAST(ti.meta_value AS UNSIGNED) FROM ${P}termmeta ti WHERE ( ti.meta_key IN ('thumbnail_id','product_attribute_image') ) AND ( ti.term_id IN (${product_terms}) )) )
       )
     ORDER BY a.ID"
  # Photo EXIF/IPTC (camera, credit, copyright) is personal data: dropped.
  wpx_strip_image_meta "$WPX_OUT/attachments.tsv"

  # --- shipping zones, locations, method instances (task 4.4.1).
  local has_shipping=0 instance_options=""
  if wpx_table_exists "${P}woocommerce_shipping_zones" &&
    wpx_table_exists "${P}woocommerce_shipping_zone_locations" &&
    wpx_table_exists "${P}woocommerce_shipping_zone_methods"; then
    has_shipping=1
    wpx_emit_table shipping_zones.tsv "zone_id zone_name zone_order" \
      "SELECT z.zone_id, z.zone_name, z.zone_order FROM ${P}woocommerce_shipping_zones z ORDER BY z.zone_id"
    wpx_emit_table shipping_zone_locations.tsv "location_id zone_id location_code location_type" \
      "SELECT zl.location_id, zl.zone_id, zl.location_code, zl.location_type FROM ${P}woocommerce_shipping_zone_locations zl ORDER BY zl.location_id"
    wpx_emit_table shipping_zone_methods.tsv "zone_id instance_id method_id method_order is_enabled" \
      "SELECT zm.zone_id, zm.instance_id, zm.method_id, zm.method_order, zm.is_enabled FROM ${P}woocommerce_shipping_zone_methods zm ORDER BY zm.zone_id, zm.method_order, zm.instance_id"
    # Option names of the method instances, built from the methods table
    # itself (never by a LIKE pattern), validated before use.
    instance_options=$(wpx_query "SELECT CONCAT('woocommerce_', zm.method_id, '_', zm.instance_id, '_settings') FROM ${P}woocommerce_shipping_zone_methods zm" --skip-column-names |
      tr -d '\r' | grep -aE '^woocommerce_[a-z0-9_]+_[0-9]+_settings$' | sort -u || true)
    # Core methods only, unless a method is named with --include-method: a
    # carrier plugin keeps its API credentials in the same instance option.
    local kept="" opt method
    for opt in $instance_options; do
      method=$(printf '%s' "$opt" | sed -E 's/^woocommerce_//; s/_[0-9]+_settings$//')
      if wpx_in_list "$method" $WPX_SHIPPING_METHODS_DEFAULT; then
        kept="${kept:+$kept }$opt"
      elif wpx_in_list "$method" ${include_methods[@]+"${include_methods[@]}"}; then
        wpx_log "WARNING: --include-method $method: exporting $opt, the settings of a non-core shipping method. The self-check scans it for secret-like names, but check the row yourself (grep '^$opt' options.tsv) for carrier credentials before you hand the bundle over."
        kept="${kept:+$kept }$opt"
      else
        wpx_log "WARNING: shipping method '$method' is not a WooCommerce core method; its instance settings ($opt) are NOT exported because carrier plugins keep API credentials there. The zone and method rows are exported; the method will need its settings re-entered after the import. To export the settings anyway, run again with --include-method $method."
      fi
    done
    instance_options=$kept
  else
    wpx_log "note: no WooCommerce shipping zone tables; shipping is not exported"
  fi

  # --- tax rates (validation only, D18).
  if wpx_table_exists "${P}woocommerce_tax_rates"; then
    wpx_emit_table tax_rates.tsv "tax_rate_id tax_rate_country tax_rate_state tax_rate tax_rate_name tax_rate_priority tax_rate_compound tax_rate_shipping tax_rate_order tax_rate_class" \
      "SELECT r.tax_rate_id, r.tax_rate_country, r.tax_rate_state, r.tax_rate, r.tax_rate_name, r.tax_rate_priority, r.tax_rate_compound, r.tax_rate_shipping, r.tax_rate_order, r.tax_rate_class FROM ${P}woocommerce_tax_rates r ORDER BY r.tax_rate_id"
  fi
  if wpx_table_exists "${P}woocommerce_tax_rate_locations"; then
    wpx_emit_table tax_rate_locations.tsv "location_id location_code tax_rate_id location_type" \
      "SELECT rl.location_id, rl.location_code, rl.tax_rate_id, rl.location_type FROM ${P}woocommerce_tax_rate_locations rl ORDER BY rl.location_id"
  fi

  # --- PPOM field groups: id, name, field config and categories only (the
  #     table also has an API key column, which is never selected).
  if wpx_table_exists "${P}nm_personalized"; then
    if wpx_column_exists "${P}nm_personalized" productmeta_categories; then
      wpx_emit_table ppom_meta.tsv "productmeta_id productmeta_name the_meta productmeta_categories" \
        "SELECT pp.productmeta_id, pp.productmeta_name, pp.the_meta, pp.productmeta_categories FROM ${P}nm_personalized pp ORDER BY pp.productmeta_id"
    else
      wpx_emit_table ppom_meta.tsv "productmeta_id productmeta_name the_meta" \
        "SELECT pp.productmeta_id, pp.productmeta_name, pp.the_meta FROM ${P}nm_personalized pp ORDER BY pp.productmeta_id"
    fi
  fi

  # --- options: the fixed allowlist + the shipping method instances.
  local o s keep names="" skipped
  for o in "${WPX_OPTIONS[@]}" $instance_options; do
    keep=1
    for s in ${skip_options[@]+"${skip_options[@]}"}; do
      [ "$s" = "$o" ] && keep=0
    done
    [ "$keep" -eq 1 ] || continue
    printf '%s' "$o" | grep -qE '^[A-Za-z0-9_-]+$' || wpx_die "bad option name in the allowlist: $o"
    names="${names:+$names,}'$o'"
  done
  wpx_emit_table options.tsv "option_name option_value" \
    "SELECT op.option_name, op.option_value FROM ${P}options op WHERE ( op.option_name IN (${names}) ) ORDER BY op.option_name"

  # Rank Math options with personal data: only allowlisted sub-keys.
  local filtered
  for o in rank-math-options-general rank-math-options-titles; do
    skipped=0
    for s in ${skip_options[@]+"${skip_options[@]}"}; do
      [ "$s" = "$o" ] && skipped=1
    done
    [ "$skipped" -eq 0 ] || continue
    if [ "$o" = rank-math-options-general ]; then
      filtered=$(wpx_filtered_option "$o" "${WPX_RANK_MATH_GENERAL_KEYS[@]}")
    else
      filtered=$(wpx_filtered_option "$o" "${WPX_RANK_MATH_TITLES_KEYS[@]}")
    fi
    [ -n "$filtered" ] && printf '%s\t%s\n' "$o" "$filtered" >>"$WPX_OUT/options.tsv"
  done

  # --- plugin list (name, status, version) for the report.
  if [ "$plugin_list" -eq 1 ]; then
    wpx_wp plugin list --fields=name,status,version --format=csv >"$WPX_OUT/plugins.csv" 2>/dev/null ||
      rm -f "$WPX_OUT/plugins.csv"
  fi

  # --- manifest.json (written last, lists the data files).
  local files=() f
  for f in "${WPX_BUNDLE_FILES[@]}"; do
    [ "$f" = manifest.json ] && continue
    [ -f "$WPX_OUT/$f" ] && files+=("file=$f")
  done
  # shellcheck disable=SC2016 # PHP code, not shell expansions.
  "$WPX_PHP" -r '
    $m = array("format" => "wp-bundle", "format_version" => 1);
    foreach (array_slice($argv, 1) as $a) {
      $p = strpos($a, "=");
      $k = substr($a, 0, $p);
      $val = (string) substr($a, $p + 1);
      if ($k === "file") { $m["files"][] = $val; }
      elseif ($val !== "") { $m[$k] = $val; }
    }
    echo json_encode($m, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
  ' -- \
    "generator=$WPX_GENERATOR" \
    "site_url=$site_url" \
    "home_url=$home_url" \
    "wp_version=$wp_version" \
    "wc_version=$wc_version" \
    "db_prefix=$P" \
    "exported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "locale=$locale" \
    ${files[@]+"${files[@]}"} >"$WPX_OUT/manifest.json"
  grep -q '"format_version": 1' "$WPX_OUT/manifest.json" || wpx_die "manifest.json could not be written"

  # --- warnings that do not block.
  local protected
  protected=$(wpx_scalar "SELECT COUNT(*) FROM ${P}posts pw WHERE ( pw.post_type IN (${WPX_POST_TYPES}) ) AND ( pw.post_status NOT IN (${WPX_EXCLUDED_STATUSES}) ) AND ( pw.post_password <> '' )")
  if [ "${protected:-0}" != 0 ]; then
    wpx_log "warning: ${protected} exported post(s) are password-protected; the password is NOT exported, the posts will import without it"
  fi
  [ "$has_shipping" -eq 1 ] || wpx_log "warning: the bundle has no shipping tables"

  # --- privacy self-check; refuse to package on any hit.
  if ! wpx_scan_forbidden "$WPX_OUT"; then
    wpx_die "self-check failed: nothing was packaged. Review the files above (or remove an option with --skip-option) and run again. Delete ${WPX_OUT} if you do not continue."
  fi
  wpx_log "self-check: OK"

  # --- summary (and the upload limits of the importer: 40 MB per file,
  #     50 MB in total; see the README).
  local size rows total=0 max_file_mb=$((WPX_MAX_FILE_BYTES / 1024 / 1024)) max_total_mb=$((WPX_MAX_TOTAL_BYTES / 1024 / 1024))
  printf '\n%-30s %10s %12s\n' "file" "rows" "bytes"
  for f in "${WPX_BUNDLE_FILES[@]}"; do
    [ -f "$WPX_OUT/$f" ] || continue
    size=$(wc -c <"$WPX_OUT/$f" | tr -d ' ')
    total=$((total + size))
    case $f in
      *.tsv | *.csv) rows=$(($(wc -l <"$WPX_OUT/$f") - 1)) ;;
      *) rows="-" ;;
    esac
    printf '%-30s %10s %12s\n' "$f" "$rows" "$size"
    [ "$size" -le "$WPX_MAX_FILE_BYTES" ] || wpx_log "warning: $f is larger than ${max_file_mb} MB; the importer upload rejects files above that size (contact the developers for a server-side import)"
  done
  printf '%-30s %10s %12s\n' "total" "" "$total"
  [ "$total" -le "$WPX_MAX_TOTAL_BYTES" ] || wpx_log "warning: the bundle is larger than ${max_total_mb} MB in total; the importer upload rejects it (contact the developers for a server-side import)"

  # --- package (flat archive) next to the directory.
  if [ "$archive" -eq 1 ]; then
    local tgz names_in=() sum
    tgz="${WPX_OUT}.tgz"
    for f in "${WPX_BUNDLE_FILES[@]}"; do
      [ -f "$WPX_OUT/$f" ] && names_in+=("$f")
    done
    (cd "$WPX_OUT" && tar -czf "$tgz" -- "${names_in[@]}")
    chmod 600 "$tgz"
    sum=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz" 2>/dev/null || true) | cut -d' ' -f1)
    printf '\narchive:   %s\nsha256:    %s\n' "$tgz" "${sum:-n/a}"
  fi
  printf 'directory: %s\n' "$WPX_OUT"
  printf '\nHand over the .tgz (or the directory). Delete both from this server afterwards.\n'
}

# Run only when executed, not when sourced (the self-check test sources it).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  wpx_main "$@"
fi
