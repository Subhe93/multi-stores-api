-- WooCommerce order archive (plans/wp-order-archive, M70): reference-only
-- copies of a store's old WooCommerce orders. Separate from "Order": no
-- customers, stock, statistics, emails or payouts are involved. Additive.

CREATE TABLE "ArchivedOrder" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "source" VARCHAR(32) NOT NULL DEFAULT 'woocommerce',
    "external_id" VARCHAR(64) NOT NULL,
    "number" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "created_at_source" TIMESTAMP(3) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "shipping_total" DECIMAL(12,2) NOT NULL,
    "discount_total" DECIMAL(12,2) NOT NULL,
    "tax_total" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "payment_method_title" TEXT,
    "shipping_method_title" TEXT,
    "customer_name" TEXT,
    "customer_email" TEXT,
    "customer_phone" TEXT,
    "billing_address" JSONB,
    "shipping_address" JSONB,
    "customer_note" TEXT,
    "refunds" JSONB,
    "raw" JSONB NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchivedOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArchivedOrderLine" (
    "id" TEXT NOT NULL,
    "archived_order_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(12,2),
    "line_total" DECIMAL(12,2) NOT NULL,
    "line_tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "product_external_id" VARCHAR(64),
    "variation_external_id" VARCHAR(64),
    "product_id" TEXT,
    "meta" JSONB,

    CONSTRAINT "ArchivedOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArchivedOrder_store_id_source_external_id_key" ON "ArchivedOrder"("store_id", "source", "external_id");
CREATE INDEX "ArchivedOrder_store_id_created_at_source_idx" ON "ArchivedOrder"("store_id", "created_at_source");
CREATE INDEX "ArchivedOrder_store_id_customer_email_idx" ON "ArchivedOrder"("store_id", "customer_email");
CREATE INDEX "ArchivedOrderLine_archived_order_id_idx" ON "ArchivedOrderLine"("archived_order_id");
CREATE INDEX "ArchivedOrderLine_product_id_idx" ON "ArchivedOrderLine"("product_id");

ALTER TABLE "ArchivedOrder" ADD CONSTRAINT "ArchivedOrder_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchivedOrderLine" ADD CONSTRAINT "ArchivedOrderLine_archived_order_id_fkey" FOREIGN KEY ("archived_order_id") REFERENCES "ArchivedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArchivedOrderLine" ADD CONSTRAINT "ArchivedOrderLine_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
