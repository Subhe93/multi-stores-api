-- CreateTable
CREATE TABLE "CustomProductFaq" (
    "id" TEXT NOT NULL,
    "custom_product_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomProductFaq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomProductFaqTranslation" (
    "id" TEXT NOT NULL,
    "faq_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,

    CONSTRAINT "CustomProductFaqTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomProductFaq_custom_product_id_idx" ON "CustomProductFaq"("custom_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomProductFaqTranslation_faq_id_locale_key" ON "CustomProductFaqTranslation"("faq_id", "locale");

-- AddForeignKey
ALTER TABLE "CustomProductFaq" ADD CONSTRAINT "CustomProductFaq_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProductFaqTranslation" ADD CONSTRAINT "CustomProductFaqTranslation_faq_id_fkey" FOREIGN KEY ("faq_id") REFERENCES "CustomProductFaq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
