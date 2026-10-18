# Deploying M4 (store apps: personalization, production, importer, designer)

Source of truth for the production rollout of the M4 milestones. Keep this file updated whenever an env var, a migration or a worker flag changes. Day-2 operations (full env table, the scheduler/worker matrix for several PM2 instances, `WORKERS=` and `CHROMIUM_*` switches, logs, disk projections, backup/restore of `storage/`, `GET /api/admin/ops/status`) are in [OPERATIONS.md](./OPERATIONS.md). Migration #9 `20261029120000_upload_quota_windows` (M5 W1-C: `UploadQuotaWindow`, `OpsJobTick`) is additive and goes through the same `migrate deploy`.

## 0. Preconditions

- Branch `feat/store-apps` at api `92589d4`+, web `76cc374`+, dashboard `f81be93`+, shared `a3c73d7`+.
- Postgres 15+, nginx behind Cloudflare, PM2 with `pm2-logrotate`.
- A non-root system user (e.g. `multistores`) owning `/var/lib/multi-stores` and the app directories. The API must run as that user before the designer app is enabled anywhere (Chromium sandbox).
- Chromium: `npx playwright install chromium-headless-shell` as that user, or a system Chromium.

## 1. Backups (before anything)

```bash
pg_dump -Fc "$DATABASE_URL" > /var/backups/multi-stores/pre-m4-$(date +%F).dump
tar -C /var/lib/multi-stores -czf /var/backups/multi-stores/storage-pre-m4.tgz storage invoices
# also copy the public uploads directory
```

## 2. Environment (API): add or verify

```
TRUST_PROXY=2                       # Cloudflare -> nginx -> node (1 if nginx is the only hop)
PUBLIC_API_URL=https://api.<host>   # the same origin the web uses
API_PUBLIC_ORIGINS=https://api.<host>
PRIVATE_STORAGE_DIR=/var/lib/multi-stores/storage
INVOICE_STORAGE_DIR=/var/lib/multi-stores/invoices
REDIRECTS_PROXY_KEY=<>=16 random chars, identical in the web env>
DESIGNER_URL_SECRET=<>=32 random chars, identical on every API instance>
DESIGNER_CHROMIUM_PATH=/usr/bin/chromium   # or DESIGNER_BROWSER_CHANNEL
DESIGNER_RENDER_QUEUE=on            # one instance 'on' until RAM is measured; others 'off'
DESIGNER_RENDER_CONCURRENCY=1
IMPORTER_WORKER=on                  # one instance
RETENTION_SCHEDULER=on              # safe on all instances (advisory lock)
BACKUP_SCHEDULER=on                 # ONE instance only (no lock)
IMPORTER_BUNDLE_DIR_ROOT=/var/lib/multi-stores/import-bundles   # admin from-directory imports only
# IMPORTER_HTML_SANITIZER=plain     # emergency only: drop every tag of imported descriptions
#                                   # (default: allowlist sanitizer, sanitize-html, D11). Switching
#                                   # changes the sanitized HTML and so makes every imported product
#                                   # UPDATE on its next run; switch back before the next run.

# optional quotas (defaults shown)
CUSTOMER_UPLOAD_DAILY_BYTES_PER_IP=524288000
CUSTOMER_UPLOAD_MIN_FREE_MB=1024
DESIGNER_UPLOAD_DAILY_BYTES_PER_IP=524288000
DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE=5368709120
DESIGNER_MAX_PHOTOS_PER_DESIGN=10
DESIGNER_UPLOAD_MIN_FREE_MB=1024
DESIGNER_MAIL_LINK_MAX_DAYS=30

# must be ABSENT in production
IMPORTER_ALLOW_PRIVATE_HOSTS, DESIGNER_RENDER_DUMP, DESIGNER_RENDER_REAL, UPDATE_GOLDEN
```

Web: `REDIRECTS_PROXY_KEY` (same value as the API). Dashboard: nothing new.

Secrets are generated on the server and never pasted into chat or logs.

## 3. nginx

- `client_max_body_size 55m` for `/api/importer/my/runs`.
- `client_max_body_size 40m` for `/api/designer/my/assets` and `/api/designer/s/*/designs/*/photos`.
- `client_max_body_size 50m` for `/api/uploads/customer`.
- `proxy_read_timeout >= 120s` on `/api/importer/` and `/api/designer/my/orders/*/print`.

## 4. Database

```bash
pm2 stop api
cd multi-stores-api && npm ci
npx prisma migrate deploy      # applies #1..#8 (20261019120000 .. 20261027120000)
npx prisma generate
```

Verify:

```sql
SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 8;
```

The partial indexes `ImportRun_one_active_per_store`, `OrderItemDesign_queue_claim_idx` and the GIN index on `OrderItemDesign.assets` must exist. Never run `prisma migrate dev` against this database: Prisma does not model partial indexes and would drop them. All migrations are hand-written SQL applied with `migrate deploy`. The full list of hand-written objects (partial indexes, CHECKs, the invoice trigger) with their migrations is [prisma/RAW-SQL.md](../prisma/RAW-SQL.md); `prisma/raw-sql.spec.ts` checks the migrations against `schema.prisma` when `SHADOW_DATABASE_URL` points at a throw-away database (run it before a release that touched the schema). Column conventions (scope columns without FK and their sweepers, string vs enum) are in [DATA-MODEL-CONVENTIONS.md](./DATA-MODEL-CONVENTIONS.md).

## 5. Build and start

- api: `npm run build`, then `pm2 restart api --update-env` as the non-root user.
- web: `npm ci && npx next build`, then `pm2 restart web`.
- dashboard: `npm ci && npx next build`, then `pm2 restart dashboard`.

## 6. Post-deploy checks

- `GET /api/health` returns 200. `GET /api/stores/by-domain/<host>` contains `redirects_version` only for stores with redirects.
- `node scripts/report-unsafe-patterns.js` (read-only): expect 0 rows, or a list of merchants to contact.
- `node prisma/scripts/seed-store-email-templates.ts` for stores created before M2/M3 (confirm idempotence on customised templates first).
- `pm2 logs api | grep -i "runs as root"` must be empty once the designer is enabled.
- `POST /api/admin/retention/run?dry_run=1`: every task reports ok.
- Existing-store smoke test: a checkout on an unrelated store is unchanged.

## 7. Enabling for a store (order of operations)

1. Admin makes the apps available; the creator enables them.
2. Store primary locale and currency match the imported content (Namez: `sv`, `SEK`), tax pricing inclusive.
3. Importer: upload the bundle (the `.tgz` / `.zip` from the export script, or its individual files), dry run, review, apply. Verify the counts. The dashboard upload is capped at 50 MB compressed and 50 MB extracted (about 3 000 products); a larger catalog (up to the 20 000-product planner limit) goes through `POST /api/admin/importer/stores/:storeId/runs/from-directory` with the files, or the `.tgz`, under `IMPORTER_BUNDLE_DIR_ROOT` on the API host (200 MB in total, 160 MB per file).
4. Designer: upload the fonts, publish the templates, enable the product links (this removes the `npp_fallback` fields per product).
5. Kustom Playground order with one designer line and one personalization line; check the print queue reaches READY and the print PNG is 3000x4200.
6. Enable the live markets; sample 20 old URLs for 301s.
7. Content migration (M5 B17, W2-B): in Mapping review → Advanced → "Old pages and posts", give every old page / post URL a target (a collection, a store page, the home page, `import` for a page that should become a draft builder page, or `skip`); the shop paths (`/shop/`, `/my-account/`, `/wp-login.php`, feeds, Rank Math sitemaps) are redirected without configuration. `3dnamez.se` is **not** an importer concern: it is a legacy domain of the same store and is handled at the domain level (a `StoreDomain` with `redirect_to` → `namez.se`, M5-PLAN B8), so the same redirect rows serve both hosts after the host redirect.

## 8. Rollback

`pm2 stop`, restore the pg dump, restore the storage tarball, check out the previous commit, `pm2 start`. Migrations #1..#8 are additive except the FK changes in #8 (NO ACTION); the data rollback is the dump.

## 9. Backups going forward

Daily `pg_dump` plus a tarball of `PRIVATE_STORAGE_DIR` and `INVOICE_STORAGE_DIR` (enable `includeUploads` in the scheduled backup). 14-day rotation. Print files are about 14 MB each and customer originals up to 25 MB each. Privacy: erasure requests are fully effective only after the rotation window.
