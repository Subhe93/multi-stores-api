-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'MANUFACTURING', 'QUALITY_CHECK', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED');

-- CreateEnum
CREATE TYPE "FulfillerType" AS ENUM ('PROVIDER', 'CREATOR');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('PENDING', 'PROCESSING', 'MANUFACTURING', 'SHIPPED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ShippingProfile" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT,
    "creator_id" TEXT,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingZone" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countries" TEXT[],
    "base_cost" DECIMAL(10,2) NOT NULL,
    "per_item_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "free_threshold" DECIMAL(10,2),
    "estimated_days_min" INTEGER NOT NULL,
    "estimated_days_max" INTEGER NOT NULL,

    CONSTRAINT "ShippingZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cart" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "store_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartItem" (
    "id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "product_id" TEXT,
    "variant_id" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "address_id" TEXT NOT NULL,
    "store_id" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "subtotal" DECIMAL(10,2) NOT NULL,
    "shipping_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "stripe_payment_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT,
    "variant_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "total_price" DECIMAL(10,2) NOT NULL,
    "customer_design_url" TEXT,
    "design_notes" TEXT,
    "fulfiller_type" "FulfillerType" NOT NULL,
    "fulfiller_id" TEXT NOT NULL,
    "fulfillment_status" "FulfillmentStatus" NOT NULL DEFAULT 'PENDING',
    "tracking_number" TEXT,
    "tracking_url" TEXT,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTimeline" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "actor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCommission" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "provider_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "platform_amount" DECIMAL(10,2) NOT NULL,
    "creator_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" TEXT NOT NULL,
    "commission_type" TEXT NOT NULL DEFAULT 'percentage',
    "commission_value" DECIMAL(5,2) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cart_customer_id_key" ON "Cart"("customer_id");

-- CreateIndex
CREATE INDEX "CartItem_cart_id_idx" ON "CartItem"("cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_order_number_key" ON "Order"("order_number");

-- CreateIndex
CREATE INDEX "Order_customer_id_idx" ON "Order"("customer_id");

-- CreateIndex
CREATE INDEX "Order_order_number_idx" ON "Order"("order_number");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "OrderItem_order_id_idx" ON "OrderItem"("order_id");

-- CreateIndex
CREATE INDEX "OrderItem_fulfiller_id_idx" ON "OrderItem"("fulfiller_id");

-- CreateIndex
CREATE INDEX "OrderTimeline_order_id_idx" ON "OrderTimeline"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCommission_order_id_key" ON "OrderCommission"("order_id");

-- AddForeignKey
ALTER TABLE "ShippingZone" ADD CONSTRAINT "ShippingZone_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ShippingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "Address"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTimeline" ADD CONSTRAINT "OrderTimeline_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCommission" ADD CONSTRAINT "OrderCommission_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
