-- CreateTable
CREATE TABLE "ProductFaq" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductFaq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductFaqTranslation" (
    "id" TEXT NOT NULL,
    "faq_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,

    CONSTRAINT "ProductFaqTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductFaq_product_id_idx" ON "ProductFaq"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductFaqTranslation_faq_id_locale_key" ON "ProductFaqTranslation"("faq_id", "locale");

-- AddForeignKey
ALTER TABLE "ProductFaq" ADD CONSTRAINT "ProductFaq_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFaqTranslation" ADD CONSTRAINT "ProductFaqTranslation_faq_id_fkey" FOREIGN KEY ("faq_id") REFERENCES "ProductFaq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
