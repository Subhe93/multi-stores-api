-- Marketplace VAT reserved for the platform (seller of record). Hand-written.
-- OrderCommission.vat_amount holds the order's VAT (lines + shipping) that the
-- platform keeps outside the provider/creator shares. Nullable, no backfill:
-- rows written before this change keep NULL (their split is settled history).

-- AlterTable
ALTER TABLE "OrderCommission" ADD COLUMN "vat_amount" DECIMAL(10,2);
