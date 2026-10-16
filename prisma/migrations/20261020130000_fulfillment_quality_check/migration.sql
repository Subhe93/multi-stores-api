-- M4.3 (platform-wide, inert): FulfillmentStatus gains QUALITY_CHECK between
-- MANUFACTURING and SHIPPED so a line can really sit in quality check. Kept
-- alone in its own migration: the value is not used here, and the status
-- mapping fix in OrdersService ships with the code. No data is changed.

-- AlterEnum
ALTER TYPE "FulfillmentStatus" ADD VALUE IF NOT EXISTS 'QUALITY_CHECK' BEFORE 'SHIPPED';
