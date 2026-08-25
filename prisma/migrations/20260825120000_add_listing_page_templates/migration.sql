-- Builder templates for the /products catalog and /collections/[handle] pages (one per store)
ALTER TYPE "PageType" ADD VALUE IF NOT EXISTS 'CATALOG_TEMPLATE';
ALTER TYPE "PageType" ADD VALUE IF NOT EXISTS 'COLLECTION_TEMPLATE';
