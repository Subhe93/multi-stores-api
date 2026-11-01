-- Customer accounts per store (plans/customer-per-store), step 2 of 2.
-- Hand-written. Every CUSTOMER must belong to a store and no staff account
-- may have one: (role = 'CUSTOMER') = (store_id IS NOT NULL).
--
-- DEPLOY ORDER: apply only after prisma/scripts/migrate-customers-per-store.ts
-- --apply has assigned every customer to a store (see
-- plans/customer-per-store/MIGRATION-NOTES.md). The guard below makes an
-- out-of-order deploy fail loudly before anything is changed; recover with
-- `npx prisma migrate resolve --rolled-back 20261109130000_user_store_check`,
-- run the data script, then `npx prisma migrate deploy` again.

DO $$
DECLARE
    bad_customers INTEGER;
    bad_staff INTEGER;
BEGIN
    SELECT count(*) INTO bad_customers FROM "User" WHERE "role" = 'CUSTOMER' AND "store_id" IS NULL;
    SELECT count(*) INTO bad_staff FROM "User" WHERE "role" <> 'CUSTOMER' AND "store_id" IS NOT NULL;
    IF bad_customers > 0 OR bad_staff > 0 THEN
        RAISE EXCEPTION 'User_customer_store_chk: % CUSTOMER row(s) without store_id and % staff row(s) with store_id. Run prisma/scripts/migrate-customers-per-store.ts --apply first (plans/customer-per-store/MIGRATION-NOTES.md).',
            bad_customers, bad_staff;
    END IF;
END $$;

-- CHECK constraints are invisible to Prisma (prisma/RAW-SQL.md).
ALTER TABLE "User" ADD CONSTRAINT "User_customer_store_chk"
    CHECK (("role" = 'CUSTOMER') = ("store_id" IS NOT NULL));
