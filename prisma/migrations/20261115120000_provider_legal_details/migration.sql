-- Provider legal details (provider phase 2, item 1). Hand-written.
-- The supplier's legal company identity (same shape and rules as
-- Store.trader_details): legal name, org number, VAT number + VIES answer,
-- address, phone, contact email, completed_at. Null until first saved.

-- AlterTable
ALTER TABLE "Provider" ADD COLUMN "legal_details" JSONB;
