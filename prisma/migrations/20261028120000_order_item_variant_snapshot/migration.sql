-- M4.3 production fixes (additive, no backfill).
--
-- OrderItem.variant_options_snapshot: the variant's option map as sold, so
-- the production checklist builds its `opt:` checks from the order-time
-- snapshot instead of the live ProductVariant row (which the creator may
-- rename or delete later). Null on older orders: their VARIANT_OPTION checks
-- are kept as inserted and never reset / staled by a later sync.
ALTER TABLE "OrderItem" ADD COLUMN "variant_options_snapshot" JSONB;

-- OrderProductionSummary.auto_advance_pending: the on-complete auto-advance
-- could not run (sync-driven READY) or failed (updateStatus threw); the next
-- checklist write / workspace read of the order retries it.
ALTER TABLE "OrderProductionSummary" ADD COLUMN "auto_advance_pending" BOOLEAN NOT NULL DEFAULT false;
