-- M6.2: long SEO description of a collection, rendered below the products
-- on the collection page. HTML, sanitised on write. `description` stays the
-- short text shown in the hero.
ALTER TABLE "CreatorCategoryTranslation" ADD COLUMN "long_description" TEXT;
