# WordPress / WooCommerce export for the importer (`wp-export.sh`)

> **ملخص بالعربية:** هذا السكربت يُشغَّل على سيرفر ووردبريس من قِبل صاحب الموقع، ويقرأ فقط (SELECT) بيانات الكتالوج: المنتجات والمتغيّرات والتصنيفات والسمات والصور والشحن والضرائب وبعض الإعدادات المسموح بها. لا يصدّر أبداً المستخدمين أو الطلبات أو العملاء أو الجلسات أو مفاتيح الـ API أو إعدادات بوابات الدفع أو أي بريد إلكتروني. يتحقق تلقائياً من الملفات قبل التغليف ويرفض التغليف إذا وجد ما يشبه سرّاً أو بريداً. الناتج مجلد وملف `.tgz` يُسلَّمان لنا ثم يُحذفان من السيرفر.

This script produces a **WordPress export bundle v1** (M4.4 design §2.1) that the
importer store app reads (`WP_BUNDLE` source). It runs on the WordPress server,
is read-only, and exports the catalog only.

## What it exports

| File | Source | Rows / columns |
|---|---|---|
| `manifest.json` | `siteurl`, `home`, `WPLANG`, `woocommerce_version`, `wp core version`, table prefix | `format`, `format_version: 1`, `site_url`, `home_url`, `wp_version`, `wc_version`, `db_prefix`, `exported_at`, `locale`, `files`. Empty values are left out: **`locale` is absent** when `WPLANG` is empty (WordPress default `en_US`), and readers must treat it as optional. |
| `posts.tsv` | `wp_posts` | `post_type IN (product, product_variation, npp_template, acf-field-group, acf-field)` and `post_status NOT IN (trash, auto-draft, inherit)`. The 23 standard columns; **`post_author` is written as 0 and `post_password` as empty**. |
| `postmeta.tsv` | `wp_postmeta` | `meta_id, post_id, meta_key, meta_value` of the posts above, without `_edit_lock` / `_edit_last` (user ids). |
| `terms.tsv` | `wp_terms` | `term_id, name, slug, term_group` (+ `term_order` when the column exists) of product taxonomies only. |
| `term_taxonomy.tsv` | `wp_term_taxonomy` | `term_taxonomy_id, term_id, taxonomy, description, parent, count` for `product_cat, product_tag, product_type, product_visibility, product_shipping_class, pa_*`. |
| `termmeta.tsv` | `wp_termmeta` | `meta_id, term_id, meta_key, meta_value` of those terms. |
| `term_relationships.tsv` | `wp_term_relationships` | `object_id, term_taxonomy_id, term_order` between exported posts and product taxonomies. |
| `attribute_taxonomies.tsv` | `wp_woocommerce_attribute_taxonomies` | `attribute_id, attribute_name, attribute_label, attribute_type, attribute_orderby, attribute_public`. |
| `attachments.tsv` | `wp_posts` (attachments) + 3 meta keys | `ID, guid, post_mime_type, post_parent, _wp_attached_file, _wp_attachment_metadata, _wp_attachment_image_alt` for attachments whose parent is an exported post **or** that are referenced by `_thumbnail_id`, `_product_image_gallery`, or term meta `thumbnail_id` / `product_attribute_image`. The metadata carries `original_image` (used to download originals instead of `-scaled` copies). |
| `options.tsv` | `wp_options` | `option_name, option_value` for a fixed allowlist (below) plus `woocommerce_<method>_<instance>_settings` for the shipping method instances listed in the methods table, **core methods only** (`flat_rate`, `free_shipping`, `local_pickup`). The instance settings of any other method (carrier plugins such as DHL, PostNord, UPS, Fraktjakt …) are left out with a warning, because those plugins keep their API credentials in the same option; `--include-method <id>` exports them after you have checked the option yourself. |
| `shipping_zones.tsv` | `wp_woocommerce_shipping_zones` | `zone_id, zone_name, zone_order` |
| `shipping_zone_locations.tsv` | `wp_woocommerce_shipping_zone_locations` | `location_id, zone_id, location_code, location_type` |
| `shipping_zone_methods.tsv` | `wp_woocommerce_shipping_zone_methods` | `zone_id, instance_id, method_id, method_order, is_enabled` |
| `tax_rates.tsv` | `wp_woocommerce_tax_rates` | `tax_rate_id, tax_rate_country, tax_rate_state, tax_rate, tax_rate_name, tax_rate_priority, tax_rate_compound, tax_rate_shipping, tax_rate_order, tax_rate_class` (validation only) |
| `tax_rate_locations.tsv` | `wp_woocommerce_tax_rate_locations` | `location_id, location_code, tax_rate_id, location_type` |
| `ppom_meta.tsv` | `wp_nm_personalized` (PPOM), if present | `productmeta_id, productmeta_name, the_meta, productmeta_categories` only (the table's API-key column is never selected) |
| `plugins.csv` | `wp plugin list` | `name, status, version` (for the import report) |
| `versions.txt` | — | **Legacy only.** Not written by this script; it stays in the file allowlist so that bundles made by hand before `manifest.json` existed are still accepted. The importer ignores it. |

Option allowlist: `siteurl, home, blogname, WPLANG, permalink_structure,
woocommerce_permalinks, woocommerce_currency, woocommerce_price_num_decimals,
woocommerce_prices_include_tax, woocommerce_calc_taxes, woocommerce_tax_based_on,
woocommerce_default_country, woocommerce_weight_unit, woocommerce_dimension_unit,
woocommerce_allowed_countries, woocommerce_specific_allowed_countries,
woocommerce_ship_to_countries, woocommerce_specific_ship_to_countries,
woocommerce_shipping_cost_requires_address, wc_hide_shipping_options, npp_display,
npp_sale, npp_welcome_template_ids, rank_math_modules, rank-math-options-sitemap,
woo_variation_swatches`. Two Rank Math options are reduced to named sub-keys
before they are written:

- `rank-math-options-general`: `wc_remove_product_base, wc_remove_category_base,
  wc_remove_category_parent_slugs, strip_category_base, noindex_hidden_products,
  attachment_redirect_urls` (the `console_email_*` addresses are dropped).
- `rank-math-options-titles`: `noindex_empty_taxonomies, pt_product_title,
  pt_product_description, tax_product_cat_title, tax_product_cat_description,
  tax_product_tag_title, tax_product_tag_description, title_separator,
  website_name` (knowledge-graph name, e-mail, phone, address and social
  profiles are dropped).

All TSV files have a header row and use the MySQL batch format: TAB between
fields, `\t \n \\ \0` escaped, SQL NULL as `NULL`. The column lists match
`src/modules/importer/adapters/wp-bundle/bundle-schema.ts`.

## What it never exports

- users, usermeta, user ids (post authors are zeroed), comments
- orders and refunds (`shop_order*` posts, HPOS `wc_orders*` tables, order items), customers, carts, sessions
- WooCommerce REST/API keys, OAuth tokens, webhooks, payment-gateway settings (Stripe, Klarna, Kustom, PayPal, Swish …)
- any option outside the allowlist, `wp-config.php`, files, uploads, plugin or theme code
- post passwords, editor locks
- e-mail addresses, phone numbers and postal addresses from the settings

## Guarantees

- **Read-only.** Every SQL statement goes through one function that refuses
  anything but a single `SELECT` / `SHOW` (no `;`, no write or session keyword,
  no `INTO OUTFILE`). The other WP-CLI calls are `db prefix`, `core version`,
  `option get` (the two Rank Math options) and `plugin list`. Nothing is
  activated, updated or written to the database.
- **No plugin code runs.** WP-CLI always runs with `--skip-plugins --skip-themes`
  (some security plugins rewrite `.htaccess` when they are loaded).
- **Explicit SQL.** Explicit column lists (no `SELECT *`), and every `WHERE`
  condition is parenthesised.
- **Self-check before packaging.** Every produced file is scanned for
  secret-like names (`consumer_key/secret`, `oauth`, `access_token`,
  `refresh_token`, `api_key`, `secret_key`, `private_key`, `password`,
  `user_pass`, `user_email`, `session_tokens`, `billing_email`, live Stripe keys,
  WooCommerce `ck_`/`cs_` keys …). The settings files (`manifest.json`,
  `options.tsv`, shipping and tax files, `plugins.csv`) are also scanned for
  e-mail addresses. Licence keys, purchase codes, tokens and webhooks
  (`licen[cs]e`, `purchase_code`, `token`, `webhook`) are checked in the
  settings files and in `postmeta.tsv` / `termmeta.tsv`; those two meta files
  are also scanned for e-mail addresses, except in product content keys
  (Rank Math title/description, variation description, `product_*` texts …),
  and the report names the meta key, never the value. In `posts.tsv` the
  product texts (`post_content`, `post_excerpt`, `post_content_filtered`) are
  not scanned (a description may say "password", "licence" or carry a
  `text-token-…` class); the title, slug, guid and every other column are.
  `posts.tsv` may only hold catalog post types, and only
  allowlisted file names may be present. On any hit the script stops **before**
  creating the archive and prints the file and line number (and, for
  `options.tsv`, the option name) — never the value.
  The scan is byte-based (`LC_ALL=C`, `grep -a`): a row with an invalid UTF-8
  byte (old Latin-1 data) is scanned like any other instead of being skipped
  as "binary".
- **Non-core shipping settings stay out.** See `options.tsv` above and
  `--include-method`.
- **Private output.** `umask 077`, the directory is `0700`, the archive `0600`.
  The default location is your home directory; the script refuses to write
  inside the WordPress root, where the files could be downloaded over HTTP.

## Prerequisites

- SSH access to the WordPress server as the site owner (the user that owns the
  WordPress files).
- [WP-CLI](https://wp-cli.org/) (`wp --info` works) and the PHP CLI it uses
  (`php -v`). Most managed hosts (Hostinger, SiteGround, …) have both.
- The `mysql` (or `mariadb`) **client** binary: `wp db query` runs it, the
  script does not talk to the database itself. `which mysql mariadb` must
  print one of them; `wp db query "SELECT 1"` is the quickest test.
- `bash`, `tar`, `gzip`, `awk`, `sed`, `grep` (standard on Linux hosts; the
  script uses only POSIX features of them plus `grep -a`, so busybox-style
  tools and `mawk` are fine; it never uses `sed -i`).
- WooCommerce active on the site.

### Hostinger shared hosting

- SSH: enable it in hPanel (Advanced → SSH access), then
  `ssh -p 65002 u<id>@<ip>`. The WordPress root is
  `~/domains/<domain>/public_html`.
- `wp` is usually on the PATH. If `wp --info` fails, download WP-CLI into
  your home and pass it with `--wp`:

  ```bash
  cd ~ && curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
  php wp-cli.phar --info
  bash ~/wp-export.sh --path ~/domains/<domain>/public_html --wp "php wp-cli.phar"
  ```

- `php` on the PATH may be a different version than the site uses; the script
  only needs it for three small filters, any PHP ≥ 7.2 works. If `php -v`
  fails, pass the versioned binary: `--php /opt/alt/php83/usr/bin/php` (or the
  path that `which php83` / hPanel → PHP configuration shows).
- `mysql` client: present on Hostinger shared plans (`which mysql`). If it is
  missing, `wp db query` prints `sh: mysql: not found` and the script stops
  with "could not check table …"; ask support to enable it.
- Expected runtime: a catalog of ~300 products with ~10 000 meta rows and
  ~2 000 attachments exports in **under a minute**; each `wp` call starts
  PHP, so about 20 calls dominate on a slow plan. The attachments query is the
  heaviest statement (one pass over the uploads with a gallery lookup per
  attachment); on a site with tens of thousands of attachments allow a few
  minutes. Memory use is small (`--quick` streams the rows).
- Nothing is written inside `public_html`; the output lands in your home
  directory and should be deleted after the hand-over.

## Run it

1. Copy the script to the server (from your computer):

   ```bash
   scp -P <ssh-port> tools/importer/wp-export.sh <user>@<host>:~/wp-export.sh
   ```

2. On the server, from the WordPress root:

   ```bash
   cd ~/domains/<your-domain>/public_html     # the folder that holds wp-config.php
   bash ~/wp-export.sh
   ```

   or from anywhere:

   ```bash
   bash ~/wp-export.sh --path ~/domains/<your-domain>/public_html
   ```

   If WP-CLI must run as root (not recommended): `--wp "wp --allow-root"`.
   If `php` is not on the PATH: `--php /usr/bin/php8.3`.
   If WP-CLI is a downloaded phar: `--wp "php wp-cli.phar"` (see Hostinger above).

3. The script prints a table of row counts per file, the total size, the
   archive path and its SHA-256, for example:

   ```text
   file                                 rows        bytes
   manifest.json                           -          805
   posts.tsv                             312       194596
   postmeta.tsv                         9120       475115
   ...
   total                                           812345
   archive:   /home/<user>/<host>-export-20261020.tgz
   sha256:    85af1150…
   directory: /home/<user>/<host>-export-20261020
   ```

   Read the `warning:` / `WARNING:` lines above the table: they tell you about
   password-protected products, shipping methods whose settings were left out
   and files above the upload limits. `note:` lines are informational (an
   optional option that does not exist on the site).

### Options

| Option | Meaning |
|---|---|
| `--path DIR` | WordPress root (default: current directory) |
| `--out DIR` | output directory outside the web root (default `~/<host>-export-<yyyymmdd>`); must not exist or be empty |
| `--wp "CMD"` | WP-CLI command (default `wp`) |
| `--php CMD` | PHP CLI used to filter the two Rank Math options (default `php`) |
| `--skip-option NAME` | leave one allowlisted option out (repeatable). It can only remove options, never add any. Use it if the self-check flags an option you do not want to share. |
| `--include-method ID` | also export the instance settings (`woocommerce_<ID>_<n>_settings`) of a non-core shipping method, e.g. `--include-method dhl_express` (repeatable). Prints a loud warning; check the row (`grep '^woocommerce_dhl_express_' options.tsv`) for carrier credentials before you hand the bundle over. Without it the zone and method rows are still exported and the method's settings must be re-entered after the import. |
| `--allow FILE:LINE` | accept one self-check hit that you have reviewed and found to be a false positive (repeatable), exactly as the self-check printed it, e.g. `--allow posts.tsv:12`. The hit is still printed, marked `(allowed by --allow …)`; any other hit still stops the export. Works with `--check` too. |
| `--no-archive` | keep only the directory |
| `--no-plugin-list` | do not write `plugins.csv` |
| `--check DIR` | only run the self-check on an existing bundle directory |

## Verify

- The script exits with status 0 and prints `self-check: OK`.
- `bash ~/wp-export.sh --check ~/<host>-export-<yyyymmdd>` re-runs the privacy
  check on the directory at any time.
- `tar -tzf ~/<host>-export-<yyyymmdd>.tgz` lists only the file names in the
  table above (flat, no folders).
- Optional spot checks: `head -n 3 posts.tsv | cut -f1,6,8,21` (id, title,
  status, type); `cut -f1 options.tsv` (option names only).

If the self-check fails, nothing is packaged. Read the reported file and line,
then either remove the option with `--skip-option NAME` and run again into a new
`--out` directory, review the line and accept it with `--allow FILE:LINE`, or
contact the developers. Delete the failed directory.

### Self-check false positives

The self-check matches *names*, not values, so it errs on the side of
stopping. Known false-positive classes (look at the line with
`sed -n '<LINE>p' <FILE> | cut -c1-200` before you decide):

| Where | Typical hit | Why it is harmless |
|---|---|---|
| `posts.tsv` title, slug or guid | a product called "Password book", a slug `api-key-holder`, a `guid` with `?token=` | product naming; the content columns are already skipped, only these short columns are scanned |
| `postmeta.tsv` / `termmeta.tsv` with a plugin key outside the content list | `_yoast_wpseo_opengraph-description` with an e-mail, `_wc_review_count`, `_elementor_data` containing the word `token` | Yoast / Elementor / builder keys are not in the product content key list; the value is still a shop text |
| `options.tsv` | `woocommerce_free_shipping_5_settings` whose title says "Fri frakt - ingen token behövs"; `woo_variation_swatches` CSS with `tooltip-password` | human text in a core settings option |
| `plugins.csv` | a plugin named `wp-password-protect` or `oauth-login` | plugin names |
| `attribute_taxonomies.tsv` | an attribute labelled "Licence type" | catalog attribute |

Real hits that must **not** be allowed: anything under
`woocommerce_<method>_<n>_settings` that is not `title`, `cost`, `tax_status`,
`requires`, `min_amount`, `ignore_discounts` or a shipping-class cost; any
`ck_`/`cs_`/`sk_live_`/`whsec_` string; any `*_api_key`, `*_token`,
`*_secret`, `*_license*` meta key; any personal e-mail address.

## Hand over

Either file works:

- **Directory** (what the importer reads today): copy the whole
  `<host>-export-<yyyymmdd>/` folder, e.g. `scp -r -P <port> <user>@<host>:~/<host>-export-<yyyymmdd> .`
- **Archive**: `scp -P <port> <user>@<host>:~/<host>-export-<yyyymmdd>.tgz .`
  and send the SHA-256 printed by the script with it.
  (Uploading archives directly in the dashboard needs the archive reader that
  is still pending; until then the developers extract it and load the directory.)

Send it through a private channel (not a public link). Then **delete both copies
from the server**:

```bash
rm -rf ~/<host>-export-<yyyymmdd> ~/<host>-export-<yyyymmdd>.tgz ~/wp-export.sh
```

## Privacy notes

- The bundle contains the public catalog (product texts, prices, SKUs, stock,
  image URLs), category and attribute data, shipping zones and costs, tax rates
  and the store's catalog settings. It holds no customer or order data.
- Image files are not in the bundle; the importer downloads them later from the
  public `wp-content/uploads` URLs of the site.
- `_wp_attachment_metadata` is exported without its `image_meta` part (the
  camera, credit, copyright, caption and keywords WordPress copies from the
  photo's EXIF/IPTC data); sizes, file name and `original_image` are kept. A
  value that cannot be read is replaced by `NULL`.
- Draft and private products are included (the import maps them to drafts).
  Password-protected products are included without their password; the script
  prints a warning with their count.
- The importer keeps uploaded bundles in private storage and deletes them 30
  days after the run (design §9.3).

## Size limits

The importer's limits (`BUNDLE_UPLOAD_MAX_FILE_BYTES` / `BUNDLE_UPLOAD_MAX_BYTES`
in `src/modules/importer/runs/bundle-store.ts`) are:

| Limit | Value | Where it is enforced |
|---|---|---|
| per file | **40 MB** | dashboard upload (multer `fileSize`) and the server-side directory import (`lstat` before reading) |
| whole bundle | **50 MB** | dashboard upload, while the request streams (413 `IMPORT_BUNDLE_TOO_LARGE`), and the directory import (`lstat` sum before reading) |
| files | 64 | both |

The script prints a `warning:` for a file above 40 MB and for a total above
50 MB; the export itself still completes. A catalog that large (roughly more
than 20 000 products, or very long `postmeta.tsv` from page-builder data) must
go through the developers' server-side import below instead of the dashboard
upload. (The `200 MB` figure of design §9.3 is the archive reader's uncompressed
ceiling, not an upload limit.)

The dashboard upload is `POST /api/importer/my/runs`. The API enforces the
total while the upload streams; the reverse proxy must still let a body of that
size through for this route, e.g. nginx `client_max_body_size 55M;` in a
`location` for `/api/importer/my/runs` only.

## For developers

- Tests (offline, no server): `bash tools/importer/test/wp-export.test.sh` runs
  the self-check and SQL-guard tests and an end-to-end export against a fake
  WP-CLI that serves `src/modules/importer/adapters/wp-bundle/__fixtures__/wp-export-v1/`;
  the output must match that fixture byte for byte.
  `npx jest src/modules/importer/adapters/wp-bundle/wp-export-format.spec.ts`
  reads the same fixture through `DirectoryBundleReader` + `WpBundleAdapter`
  and checks the script's file, column and option lists against `bundle-schema.ts`.
- When `bundle-schema.ts` changes (files, columns, option allowlist, Rank Math
  keys), update `WPX_*` in `wp-export.sh`, regenerate the fixture and run both
  test commands. `SHIPPING_METHOD_OPTION_RE` in the schema accepts any
  `woocommerce_<method>_<n>_settings`; the script's default of core methods
  only (`WPX_SHIPPING_METHODS_DEFAULT`) is a narrower subset, so bundles made
  with `--include-method` still parse.
- `manifest.locale` is optional (absent when `WPLANG` is empty); the adapter
  must fall back to the store's primary locale. `versions.txt` is legacy-only:
  the script never writes it, the allowlist keeps it for hand-made bundles.
- `wp db query` receives `--default-character-set=utf8mb4 --quick` on every
  call (forwarded to the mysql client like `--skip-column-names`): the bytes
  come out as stored regardless of `DB_CHARSET`, and rows are streamed.

### Server-side import from a directory (no dashboard upload)

For a bundle that exceeds the upload limits, or for a run the developers do
on behalf of a merchant (the Namez run), the admin endpoint
`POST /api/admin/importer/stores/<storeId>/runs/from-directory`
(`importer-admin.controller.ts`) reads an extracted bundle directory on the
API host:

1. `IMPORTER_BUNDLE_DIR_ROOT` must be set in the API environment, e.g.
   `/var/lib/multi-stores/import-bundles` (see `docs/DEPLOY-M4.md`); unset means
   the endpoint is disabled.
2. Copy the bundle **directory** (not the `.tgz`) below that root, under a
   relative name without `..` or a leading `/`, e.g.
   `/var/lib/multi-stores/import-bundles/namez/2026-10-20/`. Only the
   allowlisted file names inside it are read; anything else is ignored.
3. Ownership: the directory and its files must be readable by the user the API
   runs as (`chown -R <api-user>: <dir>; chmod 700 <dir>; chmod 600 <dir>/*`),
   and must be regular files (a symlinked file is not listed, a symlinked
   name that is read anyway is refused like an archive entry).
4. Call the endpoint as an admin with the store id, `source_id` and
   `directory: "namez/2026-10-20"` (the relative name). The API checks that the
   resolved path stays below the root, sums the `lstat` sizes against the
   limits above before reading anything, then copies the files into private
   storage as if they had been uploaded and creates the run; from there the
   merchant reviews and confirms in the dashboard as usual.
5. Delete the directory from the API host afterwards
   (`rm -rf /var/lib/multi-stores/import-bundles/namez/2026-10-20`); the
   private-storage copy is kept for 30 days by the retention task and then
   removed with the run data.
