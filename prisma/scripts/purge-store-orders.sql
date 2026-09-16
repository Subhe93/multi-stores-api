-- Purge every order (and everything hanging off it) of ONE creator's store,
-- identified by the creator's login email. Meant for wiping test orders
-- before handing a store to its owner.
--
-- Usage (dry run first, then the real thing):
--   psql "$DATABASE_URL" -v email='someone@example.com' -v mode=dry  -f purge-store-orders.sql
--   psql "$DATABASE_URL" -v email='someone@example.com' -v mode=run  -f purge-store-orders.sql
--
-- `run` keeps a copy of every deleted row in backup tables named
-- _purge_<table>_<timestamp> so the operation can be inspected or reversed.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE purge_orders AS
SELECT o.id
FROM "Order" o
JOIN "Store" s ON s.id = o.store_id
JOIN "Creator" c ON c.id = s.creator_id
JOIN "User" u ON u.id = c.user_id
WHERE u.email = :'email';

CREATE TEMP TABLE purge_items AS
SELECT id FROM "OrderItem" WHERE order_id IN (SELECT id FROM purge_orders);

\echo === target account
SELECT u.email, u.role, c.display_name, s.slug, s.store_type
FROM "User" u
LEFT JOIN "Creator" c ON c.user_id = u.id
LEFT JOIN "Store" s ON s.creator_id = c.id
WHERE u.email = :'email';

\echo === orders that will be removed
SELECT o.order_number, o.status, o.payment_method, o.payment_status, o.total, o.currency, o.created_at
FROM "Order" o WHERE o.id IN (SELECT id FROM purge_orders) ORDER BY o.created_at;

\echo === row counts per table
SELECT
  (SELECT count(*) FROM purge_orders)                                                            AS orders,
  (SELECT count(*) FROM purge_items)                                                             AS order_items,
  (SELECT count(*) FROM "OrderCustomFieldValue" WHERE order_item_id IN (SELECT id FROM purge_items)) AS item_field_values,
  (SELECT count(*) FROM "OrderTimeline"   WHERE order_id IN (SELECT id FROM purge_orders))       AS timeline,
  (SELECT count(*) FROM "OrderCommission" WHERE order_id IN (SELECT id FROM purge_orders))       AS commissions,
  (SELECT count(*) FROM "OrderPayout"     WHERE order_id IN (SELECT id FROM purge_orders))       AS payouts,
  (SELECT count(*) FROM "PromotionUsage"  WHERE order_id IN (SELECT id FROM purge_orders))       AS promotion_usage;

\if :{?mode}
\else
  \set mode dry
\endif

SELECT :'mode' = 'run' AS do_run \gset

\if :do_run
  \echo === backing up and deleting
  SELECT to_char(now(), 'YYYYMMDD_HH24MISS') AS ts \gset
  \set bk_orders       '_purge_orders_'        :ts
  \set bk_items        '_purge_order_items_'   :ts
  \set bk_field_values '_purge_field_values_'  :ts
  \set bk_timeline     '_purge_timeline_'      :ts
  \set bk_commissions  '_purge_commissions_'   :ts
  \set bk_payouts      '_purge_payouts_'       :ts
  \set bk_promo        '_purge_promo_usage_'   :ts
  CREATE TABLE :"bk_orders"       AS SELECT * FROM "Order"                 WHERE id IN (SELECT id FROM purge_orders);
  CREATE TABLE :"bk_items"        AS SELECT * FROM "OrderItem"             WHERE id IN (SELECT id FROM purge_items);
  CREATE TABLE :"bk_field_values" AS SELECT * FROM "OrderCustomFieldValue" WHERE order_item_id IN (SELECT id FROM purge_items);
  CREATE TABLE :"bk_timeline"     AS SELECT * FROM "OrderTimeline"         WHERE order_id IN (SELECT id FROM purge_orders);
  CREATE TABLE :"bk_commissions"  AS SELECT * FROM "OrderCommission"       WHERE order_id IN (SELECT id FROM purge_orders);
  CREATE TABLE :"bk_payouts"      AS SELECT * FROM "OrderPayout"           WHERE order_id IN (SELECT id FROM purge_orders);
  CREATE TABLE :"bk_promo"        AS SELECT * FROM "PromotionUsage"        WHERE order_id IN (SELECT id FROM purge_orders);

  -- Tables without ON DELETE CASCADE first, then the order rows (items,
  -- timeline, payouts and field values cascade from Order / OrderItem).
  DELETE FROM "PromotionUsage"  WHERE order_id IN (SELECT id FROM purge_orders);
  DELETE FROM "OrderCommission" WHERE order_id IN (SELECT id FROM purge_orders);
  DELETE FROM "Order"           WHERE id IN (SELECT id FROM purge_orders);

  \echo === remaining (must all be 0)
  SELECT
    (SELECT count(*) FROM "Order" WHERE id IN (SELECT id FROM purge_orders))                     AS orders,
    (SELECT count(*) FROM "OrderItem" WHERE id IN (SELECT id FROM purge_items))                  AS order_items,
    (SELECT count(*) FROM "OrderTimeline" WHERE order_id IN (SELECT id FROM purge_orders))       AS timeline,
    (SELECT count(*) FROM "OrderCommission" WHERE order_id IN (SELECT id FROM purge_orders))     AS commissions,
    (SELECT count(*) FROM "OrderPayout" WHERE order_id IN (SELECT id FROM purge_orders))         AS payouts,
    (SELECT count(*) FROM "PromotionUsage" WHERE order_id IN (SELECT id FROM purge_orders))      AS promotion_usage;
  COMMIT;
\else
  \echo === dry run only, nothing deleted
  ROLLBACK;
\endif
