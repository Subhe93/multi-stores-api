# Hand-written database objects (not modelled in `schema.prisma`)

Every DB object that exists only in migration SQL, because Prisma cannot
express it. `prisma migrate dev` / `prisma db push` would drop or skip these;
all migrations are applied with `prisma migrate deploy` (see
[docs/DEPLOY-M4.md §4](../docs/DEPLOY-M4.md)). Keep this list and the allowlist
in `prisma/raw-sql.spec.ts` in sync when a migration adds one.

| Object | Kind | Table | Migration | Why raw |
| --- | --- | --- | --- | --- |
| `ProductMarketPrice_market_product_novariant_key` | partial unique index (`WHERE variant_id IS NULL`) | `ProductMarketPrice` | `20261015120000_add_markets` | one product-level price per market; NULLs are distinct in a plain unique index |
| `Invoice_one_invoice_per_order` | partial unique index (`WHERE kind = 'INVOICE'`) | `Invoice` | `20261017120000_add_invoices` | one invoice per order, unlimited credit notes |
| `Invoice_sign_check` | CHECK constraint | `Invoice` | `20261017120000_add_invoices` | invoices never negative, credit notes never positive |
| `Invoice_credit_ref_check` | CHECK constraint | `Invoice` | `20261017120000_add_invoices` | a credit note always points at the invoice it credits |
| `invoice_guard()` | plpgsql function | — | `20261017120000_add_invoices` | immutability of issued documents (`SET LOCAL app.allow_invoice_delete = 'on'` is the dev-reset escape hatch) |
| `Invoice_guard_update`, `Invoice_guard_delete`, `Invoice_guard_truncate` | triggers (BEFORE UPDATE / DELETE / TRUNCATE) | `Invoice` | `20261017120000_add_invoices` | call `invoice_guard()` |
| `StoreCustomerTaxExemption_active` | partial unique index (`WHERE revoked_at IS NULL`) | `StoreCustomerTaxExemption` | `20261018120000_add_reverse_charge` | one active exemption per store + customer, history kept |
| `ImportRun_one_active_per_store` | partial unique index (`WHERE status IN (PLANNING, QUEUED, RUNNING, ROLLBACK_QUEUED, ROLLING_BACK)`) | `ImportRun` | `20261025120000_add_importer` | one active run per store; the API pre-check alone is not race-safe |
| `OrderItemDesign_queue_claim_idx` | partial index (`WHERE print_requested_at IS NOT NULL AND files_purged_at IS NULL AND terminal_at IS NULL`) | `OrderItemDesign` | `20261027120000_designer_indexes` | print-queue claim scans only claimable rows |
| `OrderItemDesign_assets_gin_idx` | GIN index (`jsonb_path_ops`) on `assets` | `OrderItemDesign` | `20261027120000_designer_indexes` | `assets @> [{"asset_id": …}]` lookups of the designer orphan sweep |
| `User_staff_email_key` | partial unique index (`WHERE store_id IS NULL`) | `User` | `20261109120000_user_store_id` | staff emails unique platform-wide; customers are unique per store via `User_store_id_email_key` (NULLs are distinct there) |
| `User_customer_store_chk` | CHECK constraint | `User` | `20261109130000_user_store_check` | `(role = 'CUSTOMER') = (store_id IS NOT NULL)`: every customer belongs to one store, staff to none |

The invoice objects are also kept verbatim in `prisma/sql/invoice-guards.sql`
(idempotent) so an e2e database built with `prisma db push` can re-apply them.

## Drift check: `prisma/raw-sql.spec.ts`

The spec runs `prisma migrate diff --from-migrations prisma/migrations
--to-schema-datamodel prisma/schema.prisma --script` against a shadow
database and fails when the generated script mentions anything that is not in
the allowlist above (a schema change without a migration, or a migration that
drifted from the schema). It needs a throw-away Postgres database:

```bash
SHADOW_DATABASE_URL="postgresql://postgres:postgres123@localhost:5432/multi_stores_shadow" npx jest prisma/raw-sql.spec.ts
```

Without `SHADOW_DATABASE_URL` the spec is skipped, so the normal `npx jest`
run never needs a database. Functions, triggers and CHECK constraints are
invisible to `migrate diff` (Prisma does not introspect them); only the
indexes above show up as `DROP INDEX` statements, which is the expected
output. Anything else is drift.

## Adding one

1. Write the SQL in the migration with a comment that says why Prisma cannot
   model it (and `IF NOT EXISTS` / `DROP … IF EXISTS` so re-runs are safe).
2. Add the row above and the object name to `RAW_SQL_ALLOWLIST` in
   `prisma/raw-sql.spec.ts`.
3. Mention it in the deploy doc's verify step when it protects an invariant
   (like the one-active-run index).
