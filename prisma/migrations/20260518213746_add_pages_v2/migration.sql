-- Page Builder v2: typed, versioned, themed pages that run alongside the legacy
-- StaticPage / PageBlock tables during the migration window. Storefront + dashboard
-- consume these going forward. The data copy is intentionally NOT performed here
-- (it's done lazily by the API the first time a creator opens the v2 builder for
-- a static page) so this migration is safe to roll back without losing edits.

CREATE TYPE "PageType" AS ENUM ('HOME', 'STATIC', 'LANDING', 'PRODUCT_TEMPLATE');

CREATE TABLE "Page" (
    "id"                   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "store_id"             TEXT NOT NULL,
    "type"                 "PageType" NOT NULL,
    "static_kind"          "StaticPageType",
    "slug"                 TEXT,
    "is_required"          BOOLEAN NOT NULL DEFAULT false,
    "sort_order"           INTEGER NOT NULL DEFAULT 0,
    "status"               "PageStatus" NOT NULL DEFAULT 'DRAFT',
    "seo"                  JSONB NOT NULL DEFAULT '{}',
    "published_version_id" TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Page_published_version_id_key" ON "Page"("published_version_id");
CREATE UNIQUE INDEX "Page_store_id_slug_key" ON "Page"("store_id", "slug");
CREATE UNIQUE INDEX "Page_store_id_type_static_kind_key" ON "Page"("store_id", "type", "static_kind");
CREATE INDEX "Page_store_id_type_status_idx" ON "Page"("store_id", "type", "status");

CREATE TABLE "PageTranslation" (
    "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "page_id"          TEXT NOT NULL,
    "locale"           VARCHAR(5) NOT NULL,
    "title"            TEXT,
    "meta_title"       TEXT,
    "meta_description" TEXT,

    CONSTRAINT "PageTranslation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageTranslation_page_id_locale_key" ON "PageTranslation"("page_id", "locale");

CREATE TABLE "PageSection" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "page_id"     TEXT NOT NULL,
    "section_key" TEXT NOT NULL,
    "settings"    JSONB NOT NULL DEFAULT '{}',
    "sort_order"  INTEGER NOT NULL DEFAULT 0,
    "is_hidden"   BOOLEAN NOT NULL DEFAULT false,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageSection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PageSection_page_id_sort_order_idx" ON "PageSection"("page_id", "sort_order");

CREATE TABLE "PageSectionTranslation" (
    "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "section_id" TEXT NOT NULL,
    "locale"     VARCHAR(5) NOT NULL,
    "content"    JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PageSectionTranslation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageSectionTranslation_section_id_locale_key" ON "PageSectionTranslation"("section_id", "locale");

CREATE TABLE "PageVersion" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "page_id"      TEXT NOT NULL,
    "label"        TEXT,
    "snapshot"     JSONB NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PageVersion_page_id_published_at_idx" ON "PageVersion"("page_id", "published_at");

ALTER TABLE "Page" ADD CONSTRAINT "Page_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Page" ADD CONSTRAINT "Page_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "PageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PageTranslation" ADD CONSTRAINT "PageTranslation_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageSection" ADD CONSTRAINT "PageSection_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageSectionTranslation" ADD CONSTRAINT "PageSectionTranslation_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "PageSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageVersion" ADD CONSTRAINT "PageVersion_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
