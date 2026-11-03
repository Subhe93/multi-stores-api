# Ops scripts: offsite backups to S3

Server-side scripts of plans/s3-storage Phase 1. They run as the `multistores`
user on the API host, read the API `.env` **without sourcing it** (values are
parsed, never evaluated) and never put a password on a command line or in a
log. The in-app side (upload after an admin/scheduled backup, restore from S3,
the hourly watchdog) lives in `src/modules/backups/offsite/`.

| Script | Purpose |
| --- | --- |
| `ms-backup-to-s3.sh` | Nightly: `pg_dump -Fc` + tar.gz of the storage dirs, sha256, upload under `S3_BACKUP_PREFIX` (SSE-KMS only with `S3_KMS_KEY_ID`, else the bucket default), verify, success marker, local cleanup. |
| `ms-backup-restore-from-s3.sh` | Monthly restore test: download + verify a dump and `pg_restore` it into a **named scratch database**. |
| `ms-ops-lib.sh` | Shared helpers (sourced by the two above). |

## Requirements on the host

- `pg_dump`, `pg_restore`, `psql`, `createdb` (PostgreSQL client, same major version as the server), `tar`, `sha256sum`, `flock`, `aws` (AWS CLI v2).
- `.env` of the API readable by `multistores`, with `DATABASE_URL`, `BACKUP_DIR`, `S3_BACKUP_BUCKET`, `AWS_REGION` and optionally `S3_BACKUP_PREFIX` (key prefix inside the bucket, default `backups/`, empty = none; the same bucket may hold `media/` and `private/`), `S3_KMS_KEY_ID` (SSE-KMS; without it **no** `--sse*` flag is sent and the bucket default applies), `S3_BACKUP_OBJECT_LOCK` (`true` = tag `tier=…` + per-object GOVERNANCE lock; default `false` = plain PutObject, retention is the bucket lifecycle), `S3_ENDPOINT` (MinIO in tests), `STORAGE_DRIVER`, `PRIVATE_STORAGE_DIR`, `INVOICE_STORAGE_DIR`.
- AWS key, first match wins: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` already in the environment (the cron line sources `/etc/multi-stores/backup-aws.env`, INFRA.md §5.6), then `BACKUP_AWS_ACCESS_KEY_ID`/`BACKUP_AWS_SECRET_ACCESS_KEY` in `.env` (the same writer key, also used by the in-app upload), then the API's `AWS_*` in `.env` (works only if that key may write the bucket, which the INFRA.md policies deny). The log line shows which source was used (`aws_key=`), never a value.
- IAM: the upload path needs `s3:PutObject` on the objects and `s3:ListBucket` on the bucket only (the verification is a `list-objects-v2` on the key; no HeadObject/GetObject). The production key (ListBucket + GetObject + PutObject, single bucket, INFRA.md §0) is enough; `s3:PutObjectTagging` + `s3:PutObjectRetention` (+ `kms:GenerateDataKey`/`kms:Encrypt` with a KMS key) are only needed with `S3_BACKUP_OBJECT_LOCK=true` on a dedicated Object-Lock bucket (`ms-backup-writer`, INFRA.md §5.2). The in-app watchdog uses `s3:ListBucket` (prefix `<S3_BACKUP_PREFIX>manifests/`). Deletion is never needed: the bucket lifecycle rotates the objects. Reading objects back (the restore script, the in-app restore/download of a rotated-out file) needs `s3:GetObject` (the production key has it; a write-only writer key does not).
- `xxd` and `base64` (coreutils / vim-common) for the PutObject checksum.
- Executable bits: `chmod 750 scripts/ops/*.sh`.

## Object layout in `S3_BACKUP_BUCKET`

Every key below sits under `S3_BACKUP_PREFIX` (default `backups/`); manifests, `Backup.s3_key` and the `--key`
option of the restore script use the key WITHOUT the prefix.

```
db/<yyyy-mm-dd>/db-<yyyymmdd-hhmmss>.dump              cron: pg_dump custom format
db/<yyyy-mm-dd>/db-<yyyymmdd-hhmmss>-<id8>.dump         in-app backups (same folder)
files/<yyyy-mm-dd>/files-<stamp>.tar.gz                 cron: private + invoice dirs (+ uploads/ while STORAGE_DRIVER=local)
files/<yyyy-mm-dd>/uploads-<stamp>-<id8>.tar.gz         in-app "include uploads" archive
manifests/<yyyy-mm-dd>.json                             cron success marker (keys, sizes, sha256)
manifests/<yyyy-mm-dd>-app-<id8>.json                   in-app success marker
```

Every object carries `x-amz-meta-sha256` and is uploaded with the same hash as
the PutObject `ChecksumSHA256` (`--checksum-sha256`): S3 refuses a body that does
not match, so no read-back is needed; the cron and the app then confirm the
stored size with `list-objects-v2` on the key. With `S3_BACKUP_OBJECT_LOCK=true`
every object is tagged `tier=daily|weekly|monthly` (Sunday = weekly, 1st of
the month = monthly; manifests like their dump) and weekly/monthly objects
carry a per-object GOVERNANCE lock (56 d / 365 d) — the lifecycle and Object
Lock rules of INFRA.md §3.5 select on these. With the default `false` the
objects carry no tag and no lock: the bucket lifecycle (`backups/` expires
after 90 days, INFRA.md §0.1) owns retention. Files over 5 GB go through
`s3 cp` (multipart), followed by `put-object-tagging` + `put-object-retention`
only when Object Lock is on. The watchdog
(`backups.offsite-watchdog`, hourly through the retention scheduler) lists
`manifests/` and mails the admin recipients **once a day** (event
`backup_offsite_missing`, EmailLog is the dedupe) when the newest marker is
older than 26 h or the bucket cannot be listed.

## Cron (nightly 03:30, as `multistores`)

```
sudo crontab -u multistores -e
```

```
MAILTO=ops@example.com
30 3 * * * . /etc/multi-stores/backup-aws.env; /var/www/multi-stores-api/scripts/ops/ms-backup-to-s3.sh >> /var/backups/multi-stores/offsite-cron.log 2>&1
```

`/etc/multi-stores/backup-aws.env` (mode 600, owner `multistores`) holds
`export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...` of the
`ms-backup-writer` user (INFRA.md §5.6); values already exported win over the
`.env`.

`MAILTO` delivers the script's output on a non-zero exit (cron only mails when
there is output; the script prints its log lines, so a failure always
produces mail when the host has a local MTA). Independently of cron mail, the
in-app watchdog alerts through the platform sender when no marker appears
within 26 h, so a silently broken cron is caught by the next business
morning.

First run by hand:

```
sudo -u multistores bash -c '. /etc/multi-stores/backup-aws.env; /var/www/multi-stores-api/scripts/ops/ms-backup-to-s3.sh --dry-run'   # plan + AWS identity (…/user/ms-backup-writer)
sudo -u multistores bash -c '. /etc/multi-stores/backup-aws.env; /var/www/multi-stores-api/scripts/ops/ms-backup-to-s3.sh'             # real run
tail -n 20 /var/backups/multi-stores/offsite.log
aws s3 ls s3://<bucket>/backups/manifests/      # <S3_BACKUP_PREFIX>manifests/
```

Options: `--api-dir DIR` (default `/var/www/multi-stores-api`, or `MS_API_DIR`),
`--env FILE`, `--keep N` (local dumps kept under `BACKUP_DIR/offsite/`, default
2), `--db-only`, `--dry-run`. Exit codes: 0 ok, 1 failure, 2 config/usage, 3
another run holds the lock, 4 dump/tar failed, 5 upload or verification
failed. Log: `BACKUP_DIR/offsite.log` (no secrets).

The scheduled in-app backup (admin panel, default 03:00) and the cron job are
independent; both end up in the bucket. Keep the admin scheduler on as well:
it is the only path that also records `Backup.s3_key` for the dashboard
"Offsite" column and that lets an admin restore from S3 from the panel.

## Monthly restore test (scratch database only)

Goal: prove that yesterday's offsite dump restores and contains recent data.
Takes a few minutes; the live database and the live storage dirs are never
touched. The restore script reads objects (`head-object`, falling back to
`list-objects-v2` for the size when HeadObject is refused, then `s3 cp`
down), so it needs `s3:GetObject`: the production single-bucket key has it;
with a write-only writer key use the `ms-backup-restore` key for the test
(export it, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the environment
win over the `.env`, delete it afterwards, INFRA.md §5.3). `--key` takes the
role-relative key (`db/<date>/<file>.dump`); the prefix is added by the script.

```
# 1. Yesterday's marker exists?
aws s3 ls s3://<bucket>/backups/manifests/ | tail -n 3

# 2. Restore it into a scratch database named after the date
sudo -u multistores /var/www/multi-stores-api/scripts/ops/ms-backup-restore-from-s3.sh \
  --date 2026-11-02 --target-db ms_restore_20261102 --create-db

# (optional) also unpack the files archive somewhere harmless
sudo -u multistores /var/www/multi-stores-api/scripts/ops/ms-backup-restore-from-s3.sh \
  --date 2026-11-02 --target-db ms_restore_20261102 --files-dir /var/tmp/ms-restore-files

# 3. Read the smoke line in the output / log:
#    smoke: Store=N User=N Product=N Order=N last_order=<timestamp> migrations=N
#    last_order must be from the day before the backup; migrations must equal
#    `ls prisma/migrations | wc -l` of the deployed release.

# 4. Clean up
dropdb -h <host> -U <app user> ms_restore_20261102
rm -rf /var/tmp/ms-restore-files
```

Record the result (date, key, duration, smoke line, who ran it) in the ops
log / ticket. The script refuses `--target-db <live db>` unless `--allow-live`
is passed: a real disaster restore uses the admin panel (pre-restore backup
+ `pg_restore --clean`) or, when the API is down, this script with
`--allow-live` after stopping the API (`pm2 stop`), followed by extracting the
files archive to the configured dirs and `pm2 start`.

`--create-db` needs `CREATEDB` on the app role; otherwise create the scratch
database as `postgres` first (`sudo -u postgres createdb -O <app user> ms_restore_...`)
and omit the flag. Downloads are deleted on exit unless `--keep` is given
(then they move to `BACKUP_DIR/offsite/restore-test/`). Log:
`BACKUP_DIR/offsite-restore.log`.
