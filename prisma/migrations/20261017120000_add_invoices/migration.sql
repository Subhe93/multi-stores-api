-- Invoices app (M3). The seller's legal profile (one 'default' row per
-- store), one gapless number series per (profile, kind) and the issued
-- documents themselves. Invoice.store_id / legal_profile_id carry no foreign
-- key on purpose (an issued document survives its store, like
-- Order.store_id); order_id is RESTRICT, so an invoiced order cannot be
-- deleted. Nothing is backfilled: stores without the app never get rows.

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "InvoiceTrigger" AS ENUM ('PAYMENT', 'COD_CREATED', 'COD_DELIVERED', 'MANUAL', 'REFUND', 'CANCELLATION');

-- CreateTable
CREATE TABLE "StoreLegalProfile" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "key" VARCHAR(32) NOT NULL DEFAULT 'default',
    "legal_name" TEXT,
    "brand_name" TEXT,
    "org_number" VARCHAR(32),
    "vat_number" VARCHAR(32),
    "address_line1" TEXT,
    "address_line2" TEXT,
    "postal_code" VARCHAR(16),
    "city" TEXT,
    "country_code" VARCHAR(2),
    "registered_office" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "bankgiro" VARCHAR(16),
    "plusgiro" VARCHAR(16),
    "iban" VARCHAR(34),
    "bic" VARCHAR(11),
    "bank_name" TEXT,
    "logo_url" TEXT,
    "f_tax_approved" BOOLEAN NOT NULL DEFAULT false,
    "due_days" INTEGER NOT NULL DEFAULT 30,
    "footer_note" TEXT,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Stockholm',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreLegalProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "id" TEXT NOT NULL,
    "legal_profile_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "prefix" VARCHAR(12) NOT NULL DEFAULT '',
    "padding" INTEGER NOT NULL DEFAULT 0,
    "start_number" INTEGER NOT NULL DEFAULT 1,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "issued_count" INTEGER NOT NULL DEFAULT 0,
    "last_issued_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "legal_profile_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "credited_invoice_id" TEXT,
    "trigger" "InvoiceTrigger" NOT NULL,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "locale" VARCHAR(10) NOT NULL,
    "net_total" DECIMAL(12,2) NOT NULL,
    "vat_total" DECIMAL(12,2) NOT NULL,
    "gross_total" DECIMAL(12,2) NOT NULL,
    "paid" BOOLEAN NOT NULL,
    "buyer_type" "BuyerType",
    "buyer_name" TEXT NOT NULL,
    "buyer_email" TEXT,
    "order_number" TEXT NOT NULL,
    "reason" TEXT,
    "snapshot" JSONB NOT NULL,
    "snapshot_version" INTEGER NOT NULL DEFAULT 1,
    "snapshot_sha256" VARCHAR(64) NOT NULL,
    "pdf_path" TEXT,
    "pdf_sha256" VARCHAR(64),
    "pdf_generated_at" TIMESTAMP(3),
    "emailed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreLegalProfile_store_id_idx" ON "StoreLegalProfile"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLegalProfile_store_id_key_key" ON "StoreLegalProfile"("store_id", "key");

-- CreateIndex
CREATE INDEX "InvoiceSequence_store_id_idx" ON "InvoiceSequence"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSequence_legal_profile_id_kind_key" ON "InvoiceSequence"("legal_profile_id", "kind");

-- CreateIndex
CREATE INDEX "Invoice_store_id_issue_date_idx" ON "Invoice"("store_id", "issue_date");

-- CreateIndex
CREATE INDEX "Invoice_order_id_idx" ON "Invoice"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_legal_profile_id_kind_sequence_number_key" ON "Invoice"("legal_profile_id", "kind", "sequence_number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_store_id_kind_number_key" ON "Invoice"("store_id", "kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_store_id_idempotency_key_key" ON "Invoice"("store_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "StoreLegalProfile" ADD CONSTRAINT "StoreLegalProfile_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSequence" ADD CONSTRAINT "InvoiceSequence_legal_profile_id_fkey" FOREIGN KEY ("legal_profile_id") REFERENCES "StoreLegalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_credited_invoice_id_fkey" FOREIGN KEY ("credited_invoice_id") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guards: prisma/sql/invoice-guards.sql, pasted verbatim.

-- Invoices app (M3) database guards. Kept as a standalone file so the e2e
-- suite can apply it after `prisma db push`; pasted verbatim into the
-- 20261017120000_add_invoices migration. Idempotent (safe to run twice).

-- At most one INVOICE per order (credit notes are unlimited).
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_one_invoice_per_order"
    ON "Invoice"("order_id") WHERE "kind" = 'INVOICE';

-- Signed amounts: an invoice is never negative, a credit note never
-- positive, and a credit note always points at the invoice it credits.
ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_sign_check";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_sign_check" CHECK (
    ("kind" = 'INVOICE' AND "gross_total" >= 0)
    OR ("kind" = 'CREDIT_NOTE' AND "gross_total" <= 0)
);
ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_credit_ref_check";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_credit_ref_check" CHECK (
    "kind" <> 'CREDIT_NOTE' OR "credited_invoice_id" IS NOT NULL
);

-- Immutability. An issued document is never deleted and never changed,
-- except for the PDF / email bookkeeping columns. The only way to delete is
-- the dev reset script, which sets app.allow_invoice_delete = 'on' for its
-- own transaction (SET LOCAL).
CREATE OR REPLACE FUNCTION invoice_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
        IF current_setting('app.allow_invoice_delete', true) = 'on' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Issued invoices cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['pdf_path', 'pdf_sha256', 'pdf_generated_at', 'emailed_at'])
        IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['pdf_path', 'pdf_sha256', 'pdf_generated_at', 'emailed_at'])
    THEN
        RAISE EXCEPTION 'Issued invoice % is immutable; only PDF/email bookkeeping may change', OLD."number"
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Invoice_guard_update" ON "Invoice";
CREATE TRIGGER "Invoice_guard_update" BEFORE UPDATE ON "Invoice"
    FOR EACH ROW EXECUTE FUNCTION invoice_guard();

DROP TRIGGER IF EXISTS "Invoice_guard_delete" ON "Invoice";
CREATE TRIGGER "Invoice_guard_delete" BEFORE DELETE ON "Invoice"
    FOR EACH ROW EXECUTE FUNCTION invoice_guard();

DROP TRIGGER IF EXISTS "Invoice_guard_truncate" ON "Invoice";
CREATE TRIGGER "Invoice_guard_truncate" BEFORE TRUNCATE ON "Invoice"
    FOR EACH STATEMENT EXECUTE FUNCTION invoice_guard();
