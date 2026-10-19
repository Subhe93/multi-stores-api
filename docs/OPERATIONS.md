# Operating the API (M5 W1-C)

How to run `multi-stores-api` on one or several PM2 instances: environment, which worker runs where, what to watch, disk, backups and the ops status endpoint. Deployment steps for the M4 milestones live in [DEPLOY-M4.md](./DEPLOY-M4.md); this file is the day-2 reference. Keep both updated when an env var, a worker flag or a migration changes. What each store app does, its settings, routes, tables and per-app operational notes are in [apps/README.md](./apps/README.md) (one file per app).

## 1. Environment

Every variable, grouped. Defaults in brackets; `(prod)` = required in production.

### Core / network

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | – | Postgres (Prisma URL; the `schema` parameter is stripped for the LISTEN client and pg_dump). |
| `REDIS_URL` | – | Reserved; nothing in M4/M5 needs it. |
| `PORT` | `3001` | |
| `NODE_ENV` | `development` | `production` enables the strict checks below. |
| `PUBLIC_API_URL` | – (prod) | Absolute links in emails and Kustom callbacks. |
| `API_PUBLIC_ORIGINS` | – | Extra origins of this API accepted in absolute file URLs. |
| `STOREFRONT_URL`, `REVALIDATE_SECRET` | – | Storefront cache revalidation. |
| `CORS_ALLOWED_ORIGINS` | reflect all (warns) | Exact origins or one-level wildcards. |
| `TRUST_PROXY` | none | Hop count (`2` behind Cloudflare + nginx). Required for per-IP throttles and byte budgets. |
| `CUSTOM_DOMAIN_CNAME_TARGET`, `CUSTOM_DOMAIN_A_TARGET`, `CUSTOM_DOMAIN_DNS_TIMEOUT_MS` | –, –, `5000` | Markets custom hostnames. |
| `REDIRECTS_PROXY_KEY` | – | Same value in the web app; lifts the redirect-route throttle. |
| `VIES_MODE`, `VIES_BASE_URL`, `VIES_TIMEOUT_MS`, `VIES_CACHE_TTL_HOURS`, `VIES_QUEUE_TIMEOUT_MS` | `live`, EC, `4000`, `24`, `2000` | B2B VAT checks. |

### Storage (directories; include all of them in backups)

| Variable | Default | Holds |
| --- | --- | --- |
| `PRIVATE_STORAGE_DIR` | `<cwd>/storage` | Customer upload originals, designer assets/photos/print files, importer bundles and snapshots. Never served statically. |
| `INVOICE_STORAGE_DIR` | `<cwd>/storage/invoices` | Rendered invoice PDFs. |
| `<cwd>/uploads` | fixed | Public files (product media, customer previews). |
| `BACKUP_DIR` | `<cwd>/backups` | pg_dump files and uploads tarballs. |
| `IMPORTER_BUNDLE_DIR_ROOT` | – | Admin from-directory imports only. |

### Browser (invoice PDFs and designer renders)

| Variable | Default | Notes |
| --- | --- | --- |
| `CHROMIUM_PATH` | – | Executable for BOTH renderers. |
| `CHROMIUM_CHANNEL` | – | `msedge` / `chrome` for both renderers. |
| `INVOICE_PDF_CHROMIUM_PATH`, `INVOICE_PDF_BROWSER_CHANNEL` | – | Legacy, invoice only; win over `CHROMIUM_*`. |
| `DESIGNER_CHROMIUM_PATH`, `DESIGNER_BROWSER_CHANNEL` | – | Legacy, designer only; win over the invoice names and `CHROMIUM_*`. |
| `INVOICE_PDF_ENGINE`, `DESIGNER_RENDER_ENGINE` | `chromium` | `off` = no browser (503 `*_UNAVAILABLE`). |
| `DESIGNER_RENDER_CONCURRENCY` | `1` | 1 or 2 print lanes per instance (~250 MB RAM per lane on top of ~200 MB browser). |
| `INVOICE_EMAIL_PDF_BUDGET_MS` | `8000` | |

Resolution order: designer → `DESIGNER_*`, then `INVOICE_PDF_*`, then `CHROMIUM_*`; invoice → `INVOICE_PDF_*`, then `CHROMIUM_*`. With only the legacy names set nothing changes.

### Workers per instance

| Variable | Default | Worker |
| --- | --- | --- |
| `WORKERS` | unset | Single switch: `retention,backup,importer,designer`. Names listed are on, the rest off; empty or `none` = all off. Sets the four flags below only where they are unset (legacy flags win). |
| `RETENTION_SCHEDULER` | on | Hourly retention tick. |
| `BACKUP_SCHEDULER` | on | 60 s backup scheduler tick. |
| `IMPORTER_WORKER` | on | Importer run worker (5 s tick). |
| `DESIGNER_RENDER_QUEUE` (`DESIGNER_WORKER` alias) | on | Designer print worker (15 s tick). |
| `STORE_APPS_LISTEN` | on | Dedicated `LISTEN store_apps` connection per instance. |
| `OPS_INSTANCE_ID` | `<host>:pm<pm_id>` / `<host>:<pid>` | Name of this process in the job tick table. |

### Quotas

| Variable | Default | Notes |
| --- | --- | --- |
| `CUSTOMER_UPLOAD_DAILY_BYTES_PER_IP` | 500 MB | 429 `CUSTOMER_UPLOAD_QUOTA`. Counter in Postgres (`UploadQuotaWindow`, UTC day, shared by all instances). |
| `CUSTOMER_UPLOAD_MIN_FREE_MB` | 1024 | 503 `CUSTOMER_UPLOAD_STORAGE_FULL`. |
| `CUSTOMER_UPLOAD_RETENTION_DAYS`, `CUSTOMER_UPLOAD_ORPHAN_DAYS` | forever, 30 | |
| `DESIGNER_UPLOAD_DAILY_BYTES_PER_IP`, `DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE` | 500 MB, 5 GB | 429 `DESIGNER_UPLOAD_QUOTA` (scope ip/store). Same Postgres counters. |
| `DESIGNER_MAX_PHOTOS_PER_DESIGN` | 10 | Live DB count (scope design). |
| `DESIGNER_UPLOAD_MIN_FREE_MB` | = customer floor | 503 `DESIGNER_STORAGE_FULL`. |
| `IMPORT_MEDIA_QUOTA_BYTES` | 2 GB | Per store per rolling 24 h (DB-backed). |
| `DESIGNER_MAIL_LINK_MAX_DAYS` | 30 | |

The byte counters fall back to a per-process in-memory window for 30 s after a failed DB read/write (a warning is logged); an upload is never refused because the counter table is unreachable.

### Secrets (generate on the server, never paste into chat or logs)

| Variable | Notes |
| --- | --- |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` (+ `*_EXPIRES_IN`) | |
| `ENCRYPTION_KEY` | 32 bytes base64; losing it loses stored Stripe/SMTP secrets. |
| `DESIGNER_URL_SECRET` (prod) | >= 32 chars, identical on every instance. |
| `REVALIDATE_SECRET`, `REDIRECTS_PROXY_KEY` | Shared with the web app. |

### Dev-only (must be ABSENT in production; the API logs an ERROR at boot when NODE_ENV=production and any is set)

`IMPORTER_ALLOW_PRIVATE_HOSTS`, `DESIGNER_RENDER_DUMP`, `DESIGNER_RENDER_REAL`, `UPDATE_GOLDEN`.

## 2. Scheduler / worker matrix (multi-instance PM2)

| Job | Tick | Safe on several instances? | Mechanism |
| --- | --- | --- | --- |
| Retention (`RETENTION_SCHEDULER`) | hourly | yes | `pg_try_advisory_xact_lock(hashtext('m4-retention'))` for the whole run; losers skip. |
| Backup (`BACKUP_SCHEDULER`) | 60 s | yes (M5) | The due slot is claimed under `pg_try_advisory_xact_lock(hashtext('backups'))` in a short transaction that re-reads `backup_last_run_at`; one dump per slot. A concurrent manual backup is still refused (409). |
| Importer (`IMPORTER_WORKER`) | 5 s | yes | Atomic status claim (`updateMany … count = 1`), heartbeats, stale requeue after 120 s. One instance is still the simplest. |
| Designer print queue (`DESIGNER_RENDER_QUEUE`) | 15 s | yes, RAM permitting | `FOR UPDATE SKIP LOCKED` claim; a paused instance (browser unavailable) stops claiming for 60 s and hands rows back. |
| StoreApp cache | – | yes | `pg_notify('store_apps', storeId)` on every enable/disable/settings change; each instance's `LISTEN` drops its entry at once, else the 60 s TTL. |

Recommended layout for two instances: `WORKERS=retention,backup,importer,designer` on instance 1 and `WORKERS=retention,backup` on instance 2 until RAM for a second browser is measured. The reverse proxy may route to any instance; `GET /admin/ops/status` tells which one answered.

Every tick writes one structured line on the `JobTick` logger (`{"job","instance","at","outcome",…}`; `ran` at info, `error` at warn, `idle`/`skipped` at debug) and upserts `OpsJobTick(job, instance)` (idle ticks at most every 30 s).

## 3. Logs and metrics

- `pm2 logs api | grep JobTick` — scheduler timeline per instance.
- `grep -i "runs as root"` must be empty once the designer is enabled.
- `Upload quota .* failed` — the counter table was unreachable (in-memory fallback in use).
- `LISTEN store_apps` lines — the cross-instance cache channel connected / lost (TTL fallback meanwhile).
- `Scheduled backup` / `Retention` / `Designer print worker` / `importer tick` lines carry the outcome of each pass.
- `GET /api/admin/ops/status` (below) is the one-call health view; poll it from the monitoring at >= 15 s (its cache).

## 4. Disk projections for Namez

Per designer order line: print PNG about 14 MB (3000x4200) + proof; customer photo originals up to 25 MB each (default 10 per design), customer upload originals up to 50 MB. With the default retention (originals 365 days after READY / terminal, drafts 30 days, orphans 7 days, print files until purge) plan roughly:

| Volume | Per month | Kept (max) | Disk |
| --- | --- | --- | --- |
| 300 designer lines, 2 photos each | 300 x (14 + 2 x 8) MB = 9 GB | 12 months | ~110 GB |
| 1 000 personalization uploads (avg 4 MB) | 4 GB | 60 days | ~8 GB |
| Invoices (~150 KB) | 0.2 GB | forever | ~2.5 GB / year |
| Backups (pg_dump + uploads tarball) | nightly, 14 kept | 14 x (DB + storage) | storage x 14 unless the tarball excludes `storage/` |

Keep `CUSTOMER_UPLOAD_MIN_FREE_MB` / `DESIGNER_UPLOAD_MIN_FREE_MB` at >= 1024 and alert on `disk.*.free_bytes` from the status endpoint at 10 GB. The backups directory should be a different volume (or a mounted bucket) than `storage/`, otherwise one daily tarball of 100 GB fills the disk.

## 5. Backup and restore of `storage/`

Backups (admin panel or the scheduler) produce a `pg_dump -Fc` file and, with "include uploads", a tarball of `uploads/`, `PRIVATE_STORAGE_DIR` and `INVOICE_STORAGE_DIR` when they live under the working directory (otherwise back the directories up separately, e.g. `tar -C /var/lib/multi-stores -czf storage-$(date +%F).tgz storage invoices`). Rotation: `backup_retention` (default 14) SCHEDULED backups on disk.

Restore order: stop the API, `pg_restore` the dump (admin panel "restore" does this with a pre-restore safety backup), untar the storage directories to the same paths, start the API. File keys in the DB are relative to the storage root, so the root may move as long as `PRIVATE_STORAGE_DIR` follows.

Privacy note: backups contain customer photos, uploaded files and personal data. An erasure request (GDPR) is complete only after every backup holding the data has rotated out (14 days by default); document the retention window in the privacy policy and keep the backup directory with the same access controls as `storage/`. Customer IPs in `UploadQuotaWindow` are stored hashed and purged after two days.

## 6. Ops status endpoint

`GET /api/admin/ops/status` (ADMIN JWT), read-only, cached 15 s per instance:

```json
{
  "generated_at": "…", "cached": false,
  "app": { "version": "0.0.1", "commit": "fa3ff64…", "node": "v22…" },
  "instance": { "id": "host:pm0", "hostname": "…", "pid": 1, "uptime_s": 1, "runs_as_root": false, "env": "production" },
  "workers": { "retention": true, "backup": true, "importer": true, "designer": true },
  "db": { "ok": true, "round_trip_ms": 1.2 },
  "disk": { "private_storage": { "dir": "…", "free_bytes": 1 }, "invoices": {…}, "uploads": {…}, "backups": {…} },
  "retention": { "last_run_at": "…", "last_run_instance": "…", "dry_run": false,
                 "tasks": { "customer-uploads": { "purged": 0, "skipped": 0, "errors": 0 }, "…": {} },
                 "instances": [ { "instance": "…", "ticked_at": "…", "outcome": "ran" } ] },
  "print_queue": { "counts": { "PENDING": 2, "RENDERING": 1, "READY": 40, "FAILED": 0 },
                   "oldest_pending_at": "…", "oldest_pending_age_s": 30,
                   "workers": [ { "instance": "…", "ticked_at": "…", "paused_until": null } ],
                   "paused_instances": [] },
  "importer": { "active_runs": [ { "id": "…", "store_id": "…", "status": "RUNNING", "worker_id": "…", "heartbeat_at": "…", "heartbeat_age_s": 3, "stale": false } ],
                "stale_heartbeats": 0, "queued": 0, "workers": [ … ] },
  "backup": { "enabled": true, "schedule": { "frequency": "DAILY", "time": "03:00", "weekday": 0, "retention": 14, "include_uploads": true },
              "last_run_at": "…", "next_run_at": "…", "running": false,
              "last": { "id": "…", "kind": "SCHEDULED", "status": "COMPLETED", "created_at": "…", "finished_at": "…", "error": null, "db_size_bytes": 1, "uploads_size_bytes": 1 } },
  "jobs": [ { "job": "backup", "instance": "…", "ticked_at": "…", "outcome": "idle", "payload": {…}, "ran_at": "…" } ]
}
```

A section that fails answers `{ "error": "…" }` in its place; the rest of the document is still returned. `instance`, `workers` and `disk` describe the process that answered; `retention`, `print_queue.workers`, `importer.workers` and `jobs` are cross-instance (from `OpsJobTick`). Alerts worth wiring: `db.ok=false`, `disk.*.free_bytes < 10 GB`, `print_queue.oldest_pending_age_s > 900`, `print_queue.paused_instances` non-empty for > 5 min, `importer.stale_heartbeats > 0`, `backup.last.status = FAILED`, `retention.last_run_at` older than 2 h, `instance.runs_as_root = true`.

## 7. Retention tasks added by this module

- `ops.quota-windows` — deletes `UploadQuotaWindow` rows older than 2 days.
- `ops.job-ticks` — deletes `OpsJobTick` rows older than 30 days (instances that are gone).

Both run inside the hourly retention job; `POST /api/admin/retention/run?task=ops.quota-windows&dry_run=1` previews.
