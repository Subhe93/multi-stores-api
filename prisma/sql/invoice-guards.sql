-- Invoices app (M3) database guards. Kept as a standalone file so the e2e
-- suite can apply it after `prisma db push`; pasted verbatim into the
-- 20261017120000_add_invoices migration. Idempotent (safe to run twice).
--
-- Re-apply this file after `prisma db push` or `prisma migrate reset` of a
-- database that was not built from the migrations: Prisma does not model
-- the partial index, the CHECKs or the triggers, so neither command recreates
-- them.
--
-- Escape hatch: `SET LOCAL app.allow_invoice_delete = 'on'` lets the current
-- transaction delete invoices. Any session can set it (it is not a security
-- boundary, only a guard against accidents); use it ONLY in dev reset scripts
-- (scripts/reset-data.js), never in application code.

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
