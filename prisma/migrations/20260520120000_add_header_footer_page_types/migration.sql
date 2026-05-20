-- Add HEADER and FOOTER to the PageType enum so the Page Builder v2 can
-- store store-wide chrome pages (singletons per store, no slug, undeletable).
-- The storefront StoreLayout renders their published sections on every page.

ALTER TYPE "PageType" ADD VALUE IF NOT EXISTS 'HEADER';
ALTER TYPE "PageType" ADD VALUE IF NOT EXISTS 'FOOTER';
