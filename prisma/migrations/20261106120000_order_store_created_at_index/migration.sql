-- Creator overview analytics (GET /stores/my/overview) scans a store's orders
-- by created_at range and lists its latest orders; the store order list
-- orders by created_at too. Hand-written: index only, no data change.
CREATE INDEX IF NOT EXISTS "Order_store_id_created_at_idx" ON "Order"("store_id", "created_at");
