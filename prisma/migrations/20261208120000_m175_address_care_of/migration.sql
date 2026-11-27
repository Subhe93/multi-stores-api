-- M175: "c/o" (care of) line of a delivery address, as reported by Kustom's
-- shipping address. Additive, nullable, no backfill, no rewrite. Old code
-- never reads or writes the column.
-- Rollback: ALTER TABLE "Address" DROP COLUMN IF EXISTS "care_of";
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "care_of" VARCHAR(120);
