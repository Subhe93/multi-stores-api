-- M175: the name of the person who bought an order (Kustom billing name),
-- kept apart from the parcel's recipient (Address.full_name). Additive,
-- nullable, no backfill, no rewrite. Old code never reads or writes it.
-- Rollback: ALTER TABLE "Order" DROP COLUMN IF EXISTS "buyer_name";
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "buyer_name" VARCHAR(200);
