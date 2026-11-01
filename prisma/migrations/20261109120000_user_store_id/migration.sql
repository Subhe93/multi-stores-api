-- Customer accounts per store (plans/customer-per-store), step 1 of 2.
-- Hand-written. A CUSTOMER account now belongs to exactly one store
-- (User.store_id); staff (ADMIN/CREATOR/PROVIDER) keep store_id NULL and stay
-- platform-wide. The same email may exist once per store plus once as staff.
--
-- This migration is safe on the current data: every existing row has
-- store_id NULL, so the partial unique index below enforces exactly what
-- "User_email_key" enforced before. The global email unique is dropped here
-- (not in step 2) because the data script
-- prisma/scripts/migrate-customers-per-store.ts clones multi-store customers
-- into per-store rows with the same email, which the global unique would
-- reject. Uniqueness is never weakened at any point:
--   - rows with store_id NULL (staff + not-yet-assigned customers): unique email
--   - rows with store_id set (assigned customers): unique (store_id, email)
--
-- The role/store CHECK is added by 20261109130000_user_store_check, which
-- must only be applied after the data script (see
-- plans/customer-per-store/MIGRATION-NOTES.md).

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "store_id" TEXT;

-- ON DELETE RESTRICT: a store that still has customer accounts cannot be
-- deleted (orders already block it the same way).
ALTER TABLE "User" ADD CONSTRAINT "User_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "User_store_id_created_at_idx" ON "User"("store_id", "created_at");

-- Customers: one account per (store, email). NULL store_id rows are distinct
-- here, so staff are covered by the partial index below.
CREATE UNIQUE INDEX IF NOT EXISTS "User_store_id_email_key" ON "User"("store_id", "email");

-- Staff (and customers not yet assigned to a store): platform-wide unique
-- email. Partial index: Prisma cannot model a WHERE clause (prisma/RAW-SQL.md).
CREATE UNIQUE INDEX IF NOT EXISTS "User_staff_email_key" ON "User"("email") WHERE "store_id" IS NULL;

DROP INDEX IF EXISTS "User_email_key";

-- Token revocation cutoff (auth hardening shipped with this release): JWTs
-- whose iat is at or before this instant are rejected by the JWT strategy and
-- the refresh endpoint. NULL = no cutoff. Nullable, no default: instant on
-- any table size.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokens_valid_after" TIMESTAMP(3);
