-- One-shot backfill: align OrderCommission.status with current Order.status.
-- DELIVERED         → COMPLETED
-- CANCELLED/REFUNDED/RETURNED → FAILED
-- everything else   → PENDING

UPDATE "OrderCommission" oc
SET status = 'COMPLETED'
FROM "Order" o
WHERE oc.order_id = o.id
  AND o.status = 'DELIVERED'
  AND oc.status <> 'COMPLETED';

UPDATE "OrderCommission" oc
SET status = 'FAILED'
FROM "Order" o
WHERE oc.order_id = o.id
  AND o.status IN ('CANCELLED', 'REFUNDED', 'RETURNED')
  AND oc.status <> 'FAILED';

UPDATE "OrderCommission" oc
SET status = 'PENDING'
FROM "Order" o
WHERE oc.order_id = o.id
  AND o.status NOT IN ('DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED')
  AND oc.status <> 'PENDING';
