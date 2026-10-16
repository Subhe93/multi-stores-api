#!/usr/bin/env bash
# Offline tests for tools/importer/wp-export.sh. No server, no database: a
# fake `wp` command serves the hand-made bundle fixture that the API spec
# (wp-export-format.spec.ts) also reads, so script output and API input are
# checked against the same files.
#
#   bash tools/importer/test/wp-export.test.sh
#
# Needs bash, tar and (for the end-to-end part) a PHP CLI on PATH.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../wp-export.sh"
FIXTURE="$HERE/../../../src/modules/importer/adapters/wp-bundle/__fixtures__/wp-export-v1"
TMP=$(mktemp -d)
trap '[ -n "${KEEP_TMP:-}" ] || rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
check() { # check NAME CMD...
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}
check_not() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi
}

# shellcheck source=../wp-export.sh
source "$SCRIPT"
set +e # the tests inspect exit codes themselves

# ---------------------------------------------------------------------------
# 1. wpx_scan_forbidden on fixture directories
# ---------------------------------------------------------------------------
clean_copy() { # clean_copy DIR
  mkdir -p "$1"
  cp "$FIXTURE"/* "$1"/
}

clean_copy "$TMP/clean"
check "scan: the fixture bundle is clean" wpx_scan_forbidden "$TMP/clean"

clean_copy "$TMP/secret"
printf 'woocommerce_flat_rate_9_settings\ta:1:{s:15:"consumer_secret";s:3:"abc";}\n' >>"$TMP/secret/options.tsv"
check_not "scan: consumer_secret in options is refused" wpx_scan_forbidden "$TMP/secret"

clean_copy "$TMP/oauth"
printf '999\t100\t_oauth_token\tx\n' >>"$TMP/oauth/postmeta.tsv"
check_not "scan: oauth meta key is refused" wpx_scan_forbidden "$TMP/oauth"

clean_copy "$TMP/password"
printf '1000\t100\tsome_password\tx\n' >>"$TMP/password/postmeta.tsv"
check_not "scan: password in a data row is refused" wpx_scan_forbidden "$TMP/password"

clean_copy "$TMP/email"
printf 'blogname\tcontact owner@shop.example\n' >>"$TMP/email/options.tsv"
check_not "scan: e-mail in options is refused" wpx_scan_forbidden "$TMP/email"
out=$(wpx_scan_forbidden "$TMP/email")
case $out in
  *owner@shop.example*) bad "scan: the e-mail value is never printed" ;;
  *"option blogname"*) ok "scan: reports the option name, not the value" ;;
  *) bad "scan: reports the option name ($out)" ;;
esac

clean_copy "$TMP/stripe"
printf 'woocommerce_x_1_settings\ta:1:{s:3:"key";s:12:"sk_live_abcd";}\n' >>"$TMP/stripe/options.tsv"
check_not "scan: live payment key is refused" wpx_scan_forbidden "$TMP/stripe"
out=$(wpx_scan_forbidden "$TMP/stripe")
case $out in *sk_live_abcd*) bad "scan: the secret value is never printed" ;; *) ok "scan: the secret value is never printed" ;; esac

clean_copy "$TMP/order"
awk -F '\t' 'BEGIN { OFS = "\t" } NR == 2 { $21 = "shop_order" } { print }' "$FIXTURE/posts.tsv" >"$TMP/order/posts.tsv"
check_not "scan: a shop_order row in posts.tsv is refused" wpx_scan_forbidden "$TMP/order"

clean_copy "$TMP/extra"
printf 'x\n' >"$TMP/extra/users.tsv"
check_not "scan: a file outside the allowlist is refused" wpx_scan_forbidden "$TMP/extra"

clean_copy "$TMP/hidden"
printf 'x\n' >"$TMP/hidden/.err"
check_not "scan: a leftover hidden file is refused" wpx_scan_forbidden "$TMP/hidden"

clean_copy "$TMP/header"
# The posts header contains "post_password"; header rows are not scanned.
check "scan: header rows (post_password column) are not flagged" wpx_scan_forbidden "$TMP/header"

clean_copy "$TMP/content-email"
printf '9999\t100\t_variation_description\tmail shop@shop.example\n' >>"$TMP/content-email/postmeta.tsv"
printf '9999\t10\trank_math_description\tmail shop@shop.example\n' >>"$TMP/content-email/termmeta.tsv"
printf '9998\t100\tproduct_delivery\tA token gift, licensed design\n' >>"$TMP/content-email/postmeta.tsv"
check "scan: e-mails and key-like words in product content meta are allowed" wpx_scan_forbidden "$TMP/content-email"

clean_copy "$TMP/meta-email"
printf '9999\t100\t_note\tmail owner@shop.example\n' >>"$TMP/meta-email/postmeta.tsv"
check_not "scan: e-mail in a non-content postmeta key is refused" wpx_scan_forbidden "$TMP/meta-email"
out=$(wpx_scan_forbidden "$TMP/meta-email")
case $out in
  *owner@shop.example*) bad "scan: the meta e-mail value is never printed" ;;
  *"meta _note"*) ok "scan: reports the meta key, not the value" ;;
  *) bad "scan: reports the meta key ($out)" ;;
esac

clean_copy "$TMP/term-email"
printf '9999\t10\towner_contact\towner@shop.example\n' >>"$TMP/term-email/termmeta.tsv"
check_not "scan: e-mail in a non-content termmeta key is refused" wpx_scan_forbidden "$TMP/term-email"

clean_copy "$TMP/license"
printf 'woocommerce_x_1_settings\ta:1:{s:11:"license_key";s:3:"abc";}\n' >>"$TMP/license/options.tsv"
check_not "scan: licence key in options is refused" wpx_scan_forbidden "$TMP/license"

clean_copy "$TMP/licence"
printf 'woocommerce_x_1_settings\ta:1:{s:11:"licence_key";s:3:"abc";}\n' >>"$TMP/licence/options.tsv"
check_not "scan: licence (British spelling) in options is refused" wpx_scan_forbidden "$TMP/licence"

clean_copy "$TMP/purchase"
printf '9999\t100\t_envato_purchase_code\tabc\n' >>"$TMP/purchase/postmeta.tsv"
check_not "scan: purchase_code meta is refused" wpx_scan_forbidden "$TMP/purchase"

clean_copy "$TMP/token"
printf '9999\t100\t_sync_token\tabc\n' >>"$TMP/token/postmeta.tsv"
check_not "scan: token meta is refused" wpx_scan_forbidden "$TMP/token"

clean_copy "$TMP/webhook"
printf '9999\t10\tsync\thttps://hooks.example/webhook/abc\n' >>"$TMP/webhook/termmeta.tsv"
check_not "scan: webhook in a termmeta value is refused" wpx_scan_forbidden "$TMP/webhook"

clean_copy "$TMP/content-token"
awk -F '\t' 'BEGIN { OFS = "\t" } NR == 2 { $5 = "<article class=\"text-token-text-primary\">License info</article>" } { print }' "$FIXTURE/posts.tsv" >"$TMP/content-token/posts.tsv"
check "scan: token/license words in post content are allowed" wpx_scan_forbidden "$TMP/content-token"

clean_copy "$TMP/image-meta"
printf '599\thttps://shop.example/x.jpg\timage/jpeg\t0\tx.jpg\ta:1:{s:10:"image_meta";a:1:{s:6:"credit";s:4:"Anna";}}\tNULL\n' >>"$TMP/image-meta/attachments.tsv"
check_not "scan: attachment image_meta is refused" wpx_scan_forbidden "$TMP/image-meta"

check_not "scan: --check fails on a dirty bundle" bash "$SCRIPT" --check "$TMP/secret"
check "scan: --check passes on the clean fixture" bash "$SCRIPT" --check "$TMP/clean"

# ---------------------------------------------------------------------------
# 2. read-only SQL guard (runs in a subshell because it exits)
# ---------------------------------------------------------------------------
guard() { (wpx_assert_read_only_sql "$1") 2>/dev/null; }
check "sql guard: SELECT passes" guard "SELECT a.ID FROM wp_posts a WHERE ( a.ID IN (SELECT 1) ) AND ( FIND_IN_SET(a.ID, '1,2') > 0 )"
check "sql guard: SHOW passes" guard "SHOW TABLES LIKE 'wp\\_nm\\_personalized'"
check_not "sql guard: UPDATE is refused" guard "UPDATE wp_options SET option_value = 'x'"
check_not "sql guard: two statements are refused" guard "SELECT 1; DELETE FROM wp_users"
check_not "sql guard: SELECT ... INTO OUTFILE is refused" guard "SELECT * FROM wp_users INTO OUTFILE '/tmp/x'"
check_not "sql guard: a leading DROP is refused" guard "  DROP TABLE wp_posts"

# ---------------------------------------------------------------------------
# 3. end to end with a fake WP-CLI
# ---------------------------------------------------------------------------
if ! command -v php >/dev/null 2>&1; then
  printf 'skip end-to-end tests (no php on PATH)\n'
else
  FAKE="$TMP/fake-wp"
  SQL_LOG="$TMP/sql.log"
  cat >"$FAKE" <<'FAKE_EOF'
#!/usr/bin/env bash
# Fake WP-CLI: serves the fixture bundle; logs every SQL statement.
set -euo pipefail
args=()
skip_cols=0
for a in "$@"; do
  case $a in
    --skip-plugins | --skip-themes | --path=*) ;;
    --skip-column-names) skip_cols=1 ;;
    *) args+=("$a") ;;
  esac
done
serve() { if [ "$skip_cols" -eq 1 ]; then tail -n +2 "$FX/$1"; else cat "$FX/$1"; fi; }
case "${args[0]} ${args[1]:-}" in
  "db prefix") echo wp_ ;;
  "core version") echo 7.1.3 ;;
  "plugin list") cat "$FX/plugins.csv" ;;
  "option get")
    case ${args[2]} in
      rank-math-options-general) echo '{"console_email_send_to":"owner@shop.example","console_email_reports":"on","wc_remove_product_base":"off","wc_remove_category_base":"off","strip_category_base":"off","noindex_hidden_products":"on","attachment_redirect_urls":"on","breadcrumbs":"on"}' ;;
      rank-math-options-titles) echo '{"knowledgegraph_type":"company","knowledgegraph_name":"Shop Example AB","email":"info@shop.example","phone":"+46 70 000 00 00","local_address":{"streetAddress":"Gatan 1"},"noindex_empty_taxonomies":"on","pt_product_title":"%title% %sep% %sitename%","pt_product_description":"%excerpt%","tax_product_cat_title":"%term% %sep% %sitename%","title_separator":"-","website_name":"Shop Example"}' ;;
      *) exit 1 ;;
    esac ;;
  "db query")
    sql=${args[2]}
    printf '%s\n----\n' "$sql" >>"$SQL_LOG"
    flat=$(printf '%s' "$sql" | tr '\n' ' ' | sed -E 's/^ +//; s/ +/ /g')
    case $flat in
      "SHOW TABLES LIKE "*)
        name=$(printf '%s' "$flat" | sed -E "s/.*LIKE '([^']*)'.*/\\1/" | sed 's/\\_/_/g')
        [ "${FAKE_NO_PPOM:-0}" = 1 ] && [ "$name" = wp_nm_personalized ] && exit 0
        echo "$name" ;;
      "SHOW COLUMNS FROM "*) printf '%s' "$flat" | sed -E "s/.*LIKE '([^']*)'.*/\\1/" | sed 's/\\_/_/g' ;;
      *"option_name = 'siteurl'"* | *"option_name = 'home'"*) echo https://shop.example ;;
      *"option_name = 'woocommerce_version'"*) echo 11.2.1 ;;
      *"option_name = 'WPLANG'"*) echo sv_SE ;;
      "SELECT COUNT(*)"*) echo 0 ;;
      "SELECT CONCAT('woocommerce_'"*) tail -n +2 "$FX/shipping_zone_methods.tsv" | awk -F '\t' '{ print "woocommerce_" $3 "_" $2 "_settings" }' ;;
      "SELECT p.ID, 0 AS post_author"*) serve posts.tsv ;;
      "SELECT pm.meta_id"*) serve postmeta.tsv ;;
      "SELECT t.term_id"*) serve terms.tsv ;;
      "SELECT tt.term_taxonomy_id"*) serve term_taxonomy.tsv ;;
      "SELECT tm.meta_id"*) serve termmeta.tsv ;;
      "SELECT tr.object_id"*) serve term_relationships.tsv ;;
      "SELECT wat."*) serve attribute_taxonomies.tsv ;;
      "SELECT a.ID"*)
        serve attachments.tsv
        if [ "${FAKE_IMAGE_META:-0}" = 1 ]; then
          printf '502\thttps://shop.example/wp-content/uploads/2026/05/foto.jpg\timage/jpeg\t100\t2026/05/foto.jpg\t%s\tNULL\n' \
            'a:4:{s:5:"width";i:10;s:6:"height";i:10;s:4:"file";s:16:"2026/05/foto.jpg";s:10:"image_meta";a:3:{s:6:"credit";s:10:"Anna Tab\tA";s:6:"camera";s:9:"Canon EOS";s:9:"copyright";s:6:"(c) AT";}}'
          printf '503\thttps://shop.example/wp-content/uploads/2026/05/bad.jpg\timage/jpeg\t100\t2026/05/bad.jpg\t%s\tNULL\n' \
            'a:9:{s:10:"image_meta";BROKEN'
        fi ;;
      "SELECT z."*) serve shipping_zones.tsv ;;
      "SELECT zl."*) serve shipping_zone_locations.tsv ;;
      "SELECT zm.zone_id"*) serve shipping_zone_methods.tsv ;;
      "SELECT r."*) serve tax_rates.tsv ;;
      "SELECT rl."*) : ;; # empty result: mysql prints nothing, not even the header
      "SELECT pp."*) serve ppom_meta.tsv ;;
      "SELECT op."*)
        grep -v '^rank-math-options-' "$FX/options.tsv"
        [ "${FAKE_LEAK:-0}" = 1 ] && printf 'blogname\tMail us: owner@shop.example\n'
        exit 0 ;;
      *) echo "fake wp: unexpected SQL: $flat" >&2; exit 2 ;;
    esac ;;
  *) echo "fake wp: unexpected command: $*" >&2; exit 2 ;;
esac
FAKE_EOF
  chmod +x "$FAKE"
  export FX="$FIXTURE" SQL_LOG

  run_out="$TMP/run/shop.example-export"
  mkdir -p "$TMP/run"
  bash "$SCRIPT" --wp "$FAKE" --out "$run_out" >"$TMP/run.log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then ok "e2e: export succeeds"; else bad "e2e: export succeeds (rc=$rc)"; sed 's/^/    /' "$TMP/run.log"; fi

  for f in "$FIXTURE"/*.tsv "$FIXTURE"/plugins.csv; do
    base=${f##*/}
    if cmp -s "$f" "$run_out/$base"; then ok "e2e: $base matches the fixture byte for byte"; else bad "e2e: $base matches the fixture"; diff "$f" "$run_out/$base" | head -n 5; fi
  done

  m="$run_out/manifest.json"
  check "e2e: manifest format" grep -q '"format": "wp-bundle"' "$m"
  check "e2e: manifest version" grep -q '"format_version": 1' "$m"
  check "e2e: manifest site_url" grep -q '"site_url": "https://shop.example"' "$m"
  check "e2e: manifest locale" grep -q '"locale": "sv_SE"' "$m"
  check "e2e: manifest wc_version" grep -q '"wc_version": "11.2.1"' "$m"
  check "e2e: manifest lists posts.tsv" grep -q '"posts.tsv"' "$m"
  check "e2e: manifest equals the fixture apart from exported_at" \
    bash -c 'diff <(grep -v exported_at "$1") <(grep -v exported_at "$2")' _ "$FIXTURE/manifest.json" "$m"

  check_not "e2e: no Rank Math e-mail in options.tsv" grep -q 'owner@shop.example' "$run_out/options.tsv"
  check_not "e2e: no knowledge-graph phone in options.tsv" grep -q '+46 70' "$run_out/options.tsv"
  check "e2e: archive created" test -f "$run_out.tgz"
  check "e2e: archive is flat and holds exactly the bundle files" \
    bash -c 'diff <(tar -tzf "$1" | sort) <(ls -A "$2" | sort)' _ "$run_out.tgz" "$run_out"
  check "e2e: summary prints row counts" grep -qE '^posts\.tsv +6 ' "$TMP/run.log"
  check_not "e2e: no leftover temp files" bash -c 'ls -A "$1" | grep -qE "\.part$|^\.err$"' _ "$run_out"

  check_not "e2e: SQL never touches users, orders, sessions or API keys" \
    grep -qiE 'wp_users|usermeta|shop_order|wc_orders|woocommerce_order|woocommerce_sessions|woocommerce_api_keys|wc_customer|comments' "$SQL_LOG"
  check_not "e2e: SQL never writes" grep -qiwE 'INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE' "$SQL_LOG"
  check_not "e2e: no SELECT * anywhere" grep -qF 'SELECT *' "$SQL_LOG"

  check_not "e2e: refuses a non-empty output directory" bash "$SCRIPT" --wp "$FAKE" --out "$run_out"
  mkdir -p "$TMP/wproot"
  check_not "e2e: refuses an output directory inside the WordPress root" \
    bash "$SCRIPT" --wp "$FAKE" --path "$TMP/wproot" --out "$TMP/wproot/export"
  check_not "e2e: nothing left inside the WordPress root" test -e "$TMP/wproot/export"

  # A leaked e-mail in an option must stop packaging.
  leak_out="$TMP/leak/shop.example-export"
  mkdir -p "$TMP/leak"
  FAKE_LEAK=1 bash "$SCRIPT" --wp "$FAKE" --out "$leak_out" >"$TMP/leak.log" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "e2e: a leaked e-mail stops the export"; else bad "e2e: a leaked e-mail stops the export"; fi
  check_not "e2e: no archive after a failed self-check" test -f "$leak_out.tgz"
  check_not "e2e: the failure log never shows the e-mail" grep -q 'owner@shop.example' "$TMP/leak.log"

  # image_meta (camera, credit, copyright) never leaves the shop.
  meta_out="$TMP/meta/shop.example-export"
  mkdir -p "$TMP/meta"
  FAKE_IMAGE_META=1 bash "$SCRIPT" --wp "$FAKE" --out "$meta_out" --no-archive >"$TMP/meta.log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then ok "e2e: export with image_meta succeeds"; else bad "e2e: export with image_meta succeeds (rc=$rc)"; sed 's/^/    /' "$TMP/meta.log"; fi
  check_not "e2e: image_meta is dropped" grep -qF 'image_meta' "$meta_out/attachments.tsv"
  check_not "e2e: camera / credit / copyright are gone" grep -qE 'Canon|Anna|\(c\) AT' "$meta_out/attachments.tsv"
  check "e2e: the rest of the metadata is kept" \
    grep -qF $'502\thttps://shop.example/wp-content/uploads/2026/05/foto.jpg\timage/jpeg\t100\t2026/05/foto.jpg\ta:3:{s:5:"width";i:10;s:6:"height";i:10;s:4:"file";s:16:"2026/05/foto.jpg";}\tNULL' "$meta_out/attachments.tsv"
  check "e2e: unreadable metadata with image_meta becomes NULL" \
    grep -qF $'503\thttps://shop.example/wp-content/uploads/2026/05/bad.jpg\timage/jpeg\t100\t2026/05/bad.jpg\tNULL\tNULL' "$meta_out/attachments.tsv"
  check "e2e: rows without image_meta stay byte-identical" \
    bash -c 'diff <(cat "$1") <(head -n "$(wc -l <"$1")" "$2")' _ "$FIXTURE/attachments.tsv" "$meta_out/attachments.tsv"

  # --skip-option removes an allowlisted option; PPOM table absent -> no file.
  skip_out="$TMP/skip/shop.example-export"
  mkdir -p "$TMP/skip"
  FAKE_NO_PPOM=1 bash "$SCRIPT" --wp "$FAKE" --out "$skip_out" --skip-option rank-math-options-titles --no-archive >/dev/null 2>&1
  check "e2e: --no-archive run succeeds" test -f "$skip_out/posts.tsv"
  check_not "e2e: --skip-option drops the option" grep -q '^rank-math-options-titles' "$skip_out/options.tsv"
  check_not "e2e: no ppom_meta.tsv when the table is absent" test -f "$skip_out/ppom_meta.tsv"
  check_not "e2e: --no-archive writes no archive" test -f "$skip_out.tgz"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
