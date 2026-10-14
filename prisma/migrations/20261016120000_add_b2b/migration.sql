-- B2B app (M2). Buyer type is a request-level signal; the only persistent
-- state is the company identity a customer saves as a prefill default, the
-- company fields of a (billing) address, the snapshot an order carries and
-- the buyer type / company prefill of a Kustom checkout session. Every column
-- is nullable with no default and no backfill: existing rows stay PERSON
-- orders and behave exactly as before.

CREATE TYPE "BuyerType" AS ENUM ('PERSON', 'COMPANY');

ALTER TABLE "Customer"
    ADD COLUMN "customer_type" "BuyerType",
    ADD COLUMN "company_name" TEXT,
    ADD COLUMN "org_number" VARCHAR(32),
    ADD COLUMN "vat_number" VARCHAR(32);

ALTER TABLE "Address"
    ADD COLUMN "company_name" TEXT,
    ADD COLUMN "org_number" VARCHAR(32),
    ADD COLUMN "buyer_reference" TEXT;

ALTER TABLE "Order"
    ADD COLUMN "customer_type" "BuyerType",
    ADD COLUMN "company_name" TEXT,
    ADD COLUMN "org_number" VARCHAR(32),
    ADD COLUMN "vat_number" VARCHAR(32),
    ADD COLUMN "buyer_reference" TEXT;

ALTER TABLE "KustomCheckoutSession"
    ADD COLUMN "buyer_type" "BuyerType",
    ADD COLUMN "company" JSONB;
