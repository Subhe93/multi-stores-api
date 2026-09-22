-- Per-store choice of when a Kustom authorization is captured:
-- 'on_shipment' (default, capture when the order ships or manually) or
-- 'immediate' (capture right after the purchase is confirmed).
ALTER TABLE "Creator"
ADD COLUMN     "kustom_capture_mode" TEXT NOT NULL DEFAULT 'on_shipment';
