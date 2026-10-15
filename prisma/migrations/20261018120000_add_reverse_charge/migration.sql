-- B2B app M2.5: EU reverse charge. Every VIES consultation is logged in
-- VatNumberCheck (evidence and cache); a merchant may exempt a customer in
-- StoreCustomerTaxExemption. Orders, Kustom sessions and invoices gain
-- nullable snapshot columns with no default and no backfill: existing rows
-- stay taxed normally. Invoice rows are immutable (invoice-guards.sql); the
-- new columns are only ever written on INSERT.

CREATE TYPE "TaxExemptReason" AS ENUM ('REVERSE_CHARGE', 'CUSTOMER_EXEMPT');
CREATE TYPE "TaxExemptionKind" AS ENUM ('REVERSE_CHARGE', 'FULL');
CREATE TYPE "VatCheckStatus" AS ENUM ('VALID', 'INVALID', 'UNAVAILABLE');

CREATE TABLE "VatNumberCheck" (
    "id" TEXT NOT NULL,
    "vat_number" VARCHAR(32) NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "status" "VatCheckStatus" NOT NULL,
    "error_code" VARCHAR(40),
    "name" TEXT,
    "address" TEXT,
    "request_identifier" VARCHAR(64),
    "requester" VARCHAR(32),
    "request_date" TIMESTAMP(3),
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "store_id" TEXT,
    "source" VARCHAR(16) NOT NULL,

    CONSTRAINT "VatNumberCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VatNumberCheck_vat_number_checked_at_idx" ON "VatNumberCheck"("vat_number", "checked_at");

CREATE TABLE "StoreCustomerTaxExemption" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" "TaxExemptionKind" NOT NULL,
    "vat_number" VARCHAR(32),
    "note" VARCHAR(500),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "StoreCustomerTaxExemption_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StoreCustomerTaxExemption_store_id_customer_id_idx" ON "StoreCustomerTaxExemption"("store_id", "customer_id");

-- At most one active exemption per customer and store.
CREATE UNIQUE INDEX "StoreCustomerTaxExemption_active" ON "StoreCustomerTaxExemption"("store_id", "customer_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "StoreCustomerTaxExemption" ADD CONSTRAINT "StoreCustomerTaxExemption_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreCustomerTaxExemption" ADD CONSTRAINT "StoreCustomerTaxExemption_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Order"
    ADD COLUMN "tax_exempt_reason" "TaxExemptReason",
    ADD COLUMN "vat_validation" JSONB;

CREATE INDEX "Order_store_id_tax_exempt_reason_idx" ON "Order"("store_id", "tax_exempt_reason");

ALTER TABLE "KustomCheckoutSession"
    ADD COLUMN "vat_validation" JSONB;

ALTER TABLE "Invoice"
    ADD COLUMN "tax_exempt_reason" "TaxExemptReason",
    ADD COLUMN "buyer_vat_number" VARCHAR(32),
    ADD COLUMN "buyer_country" VARCHAR(2);
