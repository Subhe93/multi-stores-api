# Importer app (`importer`) — WooCommerce to the platform

M4.4 (+ M5 waves 0–2: archive upload, HTML sanitizer, content redirects).
Moves a WordPress/WooCommerce shop's **catalog** into the store: products,
variations, categories (with SEO), attributes and swatches, product media,
PPOM / NPP personalization fields, NPP designer templates, shipping zones,
and **301 redirects** from the old URLs. Customers, orders and users are
never imported (PLAN.md decision 2). Built for and run on Namez (namez.se,
2026-10-17: 35 products, 232 variations, 78 categories, 194 redirects).

---

## Part 1 — for merchants and support

### How it works, in four steps

1. **Export** on the old WordPress server with the read-only script
   `wp-export.sh` (download it from the Sources tab; documentation in
   `multi-stores-api/tools/importer/README.md`). It exports the catalog
   tables only and refuses to pack anything that looks like a secret or an
   e-mail address. Output: a folder and a `.tgz`.
2. **Upload** the `.tgz` / `.zip` (or the extracted files) as a new run.
3. **Dry run** (plan): the importer reads the bundle and shows what it
   would create / update / skip, with warnings; nothing is written yet.
   **Mapping review** lets you choose the platform category, what to
   import, the conflict policy, label overrides, old page/post targets, etc.
4. **Confirm** → the run is applied in the background with live progress.
   A completed run can be **rolled back**.

Re-running the same bundle is safe: unchanged items are reported as
UNCHANGED, items you edited on the platform are skipped by default
(`SKIP_MODIFIED`), and a re-run repairs partial failures.

### What changes in the dashboard

`/creator/importer` with tabs **Sources**, **Runs**, **Mapping review**,
**Redirects** (`app/creator/importer/page.tsx`, `components/importer/*`).
With the app off the page is read-only (runs and redirects only, the
`TABS = ['runs', 'redirects']` branch). Product and category forms gained a
short description and category SEO / "noindex when empty" fields (platform
columns added by this milestone).

### What the shopper sees

Imported products look like any other product. Old URLs
(`/produkt/<slug>/`, `/product-category/…`, `?p=<id>` when enabled, WordPress
system paths like `/shop/`, `/my-account/`) answer **301** to their new
location. Redirects are resolved by the web proxy, which loads the store's
redirect list once per `redirects_version` (only stores with redirects pay
for it, M4.4 D17).

### When it is off (G0)

All write routes answer `403 STORE_APP_NOT_ENABLED`; reads (sources, runs,
reports, redirects list) stay open. Imported data and **redirects stay
active** — they are platform rows (`StoreRedirect`), not app state. Editing
redirects also needs the app (`redirects-creator.controller.ts` gates the
writes with `@RequireApp('importer')`).

### How to enable

1. Store must be **INDEPENDENT** and have the **markets** app enabled
   (`depends_on: ['markets']`; disabling markets while the importer is on is
   refused with `STORE_APP_DEPENDENCY_IN_USE`).
2. Set the store's primary locale and currency to match the source **before
   the first run** (Namez: `sv`, `SEK`, INCLUSIVE tax) — DEPLOY-M4.md §7.
3. Enable [personalization](./personalization.md) (PPOM fields) and
   [designer](./designer.md) (NPP templates) first if the source uses them.

The app has **no `StoreApp.settings`**; configuration lives on the source
(`ImportSource.settings`) and on each run (`ImportRun.options`).

### Source fields (`dto/source.dto.ts`)

| Field | Meaning |
|---|---|
| `kind` | `WP_BUNDLE` (supported). `WC_REST` exists in the enum but is refused as a run source (`assertBundleKind`); the dashboard shows it disabled |
| `name` | label (≤ 120) |
| `site_url` | old shop URL → `site_host` |
| `host_aliases` | other hosts of the old shop rewritten to `site_host` (Namez: `3dnamez.se`) |
| `settings` | `{product_base, category_base, tag_base, locale, currency, uploads_path}` (Namez: `produkt`, `product-category`, `product-tag`, `sv`, `SEK`) |

### Run options (`ImportRun.options`, `runs/run-options.ts` `normalizeRunOptions`)

Edited in Mapping review (`PUT /importer/my/runs/:id/options`). Defaults
from `defaultRunOptions()`:

| Option | Default | Meaning |
|---|---|---|
| `scopes.{categories,products,media,shipping,personalization,templates,redirects}` | `true` | what to import |
| `scopes.pages` | `false` | create **draft** builder pages for old pages mapped to `import` |
| `platform_category_id` | `null` | platform category of every product; **required** to confirm (`IMPORT_PLATFORM_CATEGORY_REQUIRED`) |
| `skip_ext_ids` | `[]` | source items to leave out |
| `include_drafts` | `true` | import non-published products |
| `status_map` | publish→PUBLISHED; draft/private/pending/future→DRAFT | target status per source status |
| `conflict_policy` | `SKIP_MODIFIED` | or `OVERWRITE` (overwrite merchant edits) |
| `on_source_removed` | `keep` | `keep` \| `draft` \| `archive` for items gone from the source |
| `match_existing` | `{categories:'slug', products:'none'}` | adopt existing categories by slug |
| `customization_type_rules` | `[]` | map source mechanisms to a customization type (and designer) |
| `term_cleanup` | strip price suffix, trailing colon, unicode normalise: all `true` | attribute/term label clean-up |
| `label_overrides`, `faq_labels` | `{}` | text replacements |
| `shipping` | `{method_names:{}, default_days:{min:2,max:4}, free_shipping_as_threshold:true}` | shipping mapping |
| `designer_fallback_fields` | `true` | create plain fields for NPP products while their designer link is disabled |
| `redirect_skipped` | `true` | redirect skipped products too |
| `redirect_shortlinks` | `false` | also redirect `/?p=<id>` (one row per product) |
| `verify_media` | `false` | re-check media already imported |
| `stock_on_update` | `keep` | or `overwrite` source stock on UPDATE |
| `preset_help_images` | `{}` | help images per preset (`names_equal_length: {name_1, name_2, model_text}`) |
| `content_redirects` | `{mode:'map', targets:{}}` | old pages/posts: `map` (only listed targets), `home`, `skip`; targets are a path, `home`, `skip` or `import` |
| `inline_image_hosts` | `[]` | extra hosts whose `<img>` in descriptions are kept |

A saved Namez preset exists in code (`runs/profiles/namez-2026.ts`) but is
only used by tests; it is **not offered** by the dashboard or the API, so the
merchant sets these options by hand in Mapping review.

### Worked example — Namez (namez.se)

1. Owner runs `wp-export.sh` on the Hostinger WordPress (read-only), sends
   the `.tgz`.
2. Sources → new `WP_BUNDLE` source: `site_url https://namez.se`,
   `host_aliases ["3dnamez.se"]`, settings as above.
3. Runs → upload the `.tgz` → dry run: 35 products, 232 variations, 78
   categories (24 empty), 194 redirects, 14 personalization templates.
4. Mapping review: platform category "Gifts", `conflict_policy
   SKIP_MODIFIED`, old pages → targets.
5. Confirm. Re-running later with the same bundle (e.g. after a fix) only
   touches what changed (2026-10-17: a second run added 72 NPP fields and 3
   images).

### Limits and known gaps

- Dashboard upload: **50 MB compressed and 50 MB extracted** (~3 000
  products; each plain file ≤ 40 MB). Larger catalogs (planner limit 20 000
  products) go through the admin route with files under
  `IMPORTER_BUNDLE_DIR_ROOT` on the API host (200 MB total, 160 MB per file)
  — DEPLOY-M4.md §7.
- Catalog only: no customers, orders, reviews, coupons or users.
- WooCommerce REST import is not available (`WC_REST` refused).
- WPML (namez.shop en/ar) import is postponed (M5-PLAN M5.7).
- Shipping: only core WooCommerce methods (`flat_rate`, `free_shipping`,
  `local_pickup`) are exported; carrier-plugin methods are left out unless
  `--include-method` is used (tools/importer/README.md).
- Descriptions are sanitized with an allowlist (sanitize-html); images in
  descriptions hosted elsewhere are removed unless their host is in
  `inline_image_hosts` (`W_HTML_IMAGE_REMOVED`).
- Media: at most `IMPORT_MEDIA_QUOTA_BYTES` (2 GB) per store per rolling
  24 h; private / internal hosts are never fetched.
- Rollback is refused when a newer completed run exists, and it respects
  merchant edits made after the run (M5-PLAN B11/B12, PROGRESS 4.4.3).
- `3dnamez.se` → `namez.se` is **not** an importer job; it is a store domain
  with `redirect_to` (DEPLOY-M4.md §7.7).
- Only one active run per store (partial unique index
  `ImportRun_one_active_per_store`).

---

## Part 2 — for developers and operators

### Files

`src/modules/importer/`: `adapters/` (`wp-bundle/wp-bundle.adapter.ts`,
`bundle-schema.ts`, `tsv.ts`, `php-unserialize.ts`, plugin detectors
`acf`, `iwings`, `npp`, `ppom`, `rank-math`, `wvs`; `archive-bundle.ts`
with zip/tgz bomb and zip-slip guards), `model/` (normalized model, clean,
presets, dry-run summary), `planner/` (`planner.ts`, `plan-*.ts`,
`state-loader.ts`), `apply/` (`apply-*.ts`, `rollback.ts`), `mapping/`,
`media/` (`media-importer.ts`, `safe-fetch.ts`, `ip-policy.ts`, `sniff.ts`),
`html/html-sanitizer.ts`, `runs/` (`import-runs.service.ts`,
`import-engine.service.ts`, `import-worker.service.ts`, `bundle-store.ts`,
`importer-retention.task.ts`, `run-options.ts`, `run-state.ts`),
`ports/personalization.port.ts`; NPP templates through
`src/modules/designer/npp/`. Redirects: `src/modules/redirects/`. Export
script: `tools/importer/wp-export.sh` (+ bash tests in `tools/importer/test`).
Web: redirect handling in `src/proxy.ts`. Dashboard:
`app/creator/importer/page.tsx`, `components/importer/*`.

### Data model (migration `20261025120000_add_importer`)

| Table | Notes |
|---|---|
| `ImportSource` | `kind`, `name`, `site_host`, `host_aliases[]`, `credentials_enc` (REST, unused), `settings` JSON; unique `(store_id, site_host, kind)` |
| `ImportRun` | `status` (`UPLOADED → PLANNING → PLANNED / PLAN_FAILED → QUEUED → RUNNING → COMPLETED / COMPLETED_WITH_WARNINGS / FAILED / CANCELLED`, then `ROLLBACK_QUEUED → ROLLING_BACK → ROLLED_BACK / ROLLBACK_FAILED`), `bundle_key/sha/bytes`, `snapshot_key`, `catalog_hash`, `options` JSON, `plan_fingerprint`, `summary`, `progress`, `error`, `attempt`, `worker_id`, `heartbeat_at`, `cancel_requested_at`, actor and timestamp columns |
| `ImportRunItem`, `ImportRunLog` | per-entity plan/apply rows and the log |
| `ImportEntity` | the ledger: source ref → platform target, hashes for UNCHANGED detection; `store_id` without FK (swept) |
| `ImportMedia` | media index (source URL → stored file) |
| `StoreRedirect` | `from_path` → `to_path`, `status_code`, `source` (`RedirectSource`), `is_active`, `import_run_id` (no FK) |
| platform (+) | `Product.external_ref`, `ProductVariant.external_ref`, `CreatorCategory.external_ref` + `noindex_when_empty`, `CreatorCategoryTranslation.meta_title/meta_desc`, `ProductTranslation.short_description` |

`external_ref` (`woo:<host>:<type>:<id>`) is hidden from every public
storefront payload. Partial indexes are hand-written SQL
(`prisma/RAW-SQL.md`); never run `prisma migrate dev` on these databases.

### API routes

Creator (`CREATOR`, prefix `/api/importer/my`; `@RequireApp('importer')` on writes):

| Method + path | Gated | Purpose |
|---|---|---|
| `GET sources` / `POST sources` / `PUT sources/:id` / `DELETE sources/:id` | writes | sources |
| `POST sources/:id/verify` | yes | check the source |
| `GET export-script` | no | download `wp-export.sh` |
| `POST runs` (multipart: `source_id`, `options` JSON, `file` **or** `files[]`) | yes | upload + plan |
| `GET runs`, `GET runs/:id`, `GET runs/:id/items`, `GET runs/:id/logs`, `GET runs/:id/report.csv` | no | read |
| `PUT runs/:id/options` | yes | Mapping review (re-plans) |
| `POST runs/:id/confirm` | yes | PLANNED → QUEUED |
| `POST runs/:id/cancel`, `POST runs/:id/rollback`, `DELETE runs/:id` | yes | |

Admin: `POST /api/admin/importer/stores/:storeId/runs/from-directory`
(`ADMIN`, app must be on for that store). Redirects: `GET/POST/PUT/DELETE
/api/redirects/my[/:id]`, `POST /api/redirects/my/bulk` (CSV),
`POST /api/redirects/my/test` (writes gated by the importer app); public
`GET /api/stores/:slug/redirects?v=` and `GET /api/stores/:slug/redirects/resolve`.

### Worker / retention

- `ImportWorkerService`: 5 s tick, atomic status claim, heartbeats,
  requeue after 120 s without heartbeat (`STALE_AFTER_MS`); the claim is
  re-checked before each product (M5 B10). Safe on several instances, one
  is simplest (OPERATIONS.md §2).
- Retention task `importer.bundles` (hourly scheduler): bundles and catalog
  snapshots deleted 30 days after a run finished; run rows (items, logs)
  after 180 days; ledger, media and redirects kept, except orphans of
  deleted stores (`importer-retention.task.ts`).

### Env

| Variable | Default | Notes |
|---|---|---|
| `IMPORTER_WORKER` (or `WORKERS=…importer…`) | on | worker on this instance |
| `IMPORTER_BUNDLE_DIR_ROOT` | – | admin from-directory imports only |
| `IMPORT_MEDIA_QUOTA_BYTES` | 2 GB | per store per rolling 24 h |
| `IMPORTER_HTML_SANITIZER` | allowlist | `plain` = emergency only (strips every tag; makes every product UPDATE on its next run) |
| `IMPORTER_ALLOW_PRIVATE_HOSTS` | – | **dev only**, must be absent in production |
| `REDIRECTS_PROXY_KEY` | – | ≥ 16 chars, same value in the web env (lifts the redirect-route throttle for the proxy) |

nginx: `client_max_body_size 55m` and `proxy_read_timeout ≥ 120s` on
`/api/importer/` (DEPLOY-M4.md §3). Node ≥ 22.12 on the API host for the
archive reader (PROGRESS.md 5.4).

### Tests worth running

`npx jest src/modules/importer` — especially `planner/importer-flow.spec.ts`,
`planner/namez-full-import.spec.ts`, `adapters/wp-bundle/namez-full-export.spec.ts`
(real Namez slice), `apply/engine-fixes.spec.ts`, `media/safe-fetch.spec.ts`,
`html/html-sanitizer.spec.ts`, `runs/bundle-retention.spec.ts`. The export
script has its own bash tests in `tools/importer/test`.

### Operational notes

- Private storage holds bundles and snapshots (`PRIVATE_STORAGE_DIR`);
  include it in backups.
- `GET /api/admin/ops/status` → `importer.active_runs`, `stale_heartbeats`
  (alert when > 0).
- After a deploy that changes the sanitizer, the next run updates every
  product once (expected; PROGRESS.md 5.4).
