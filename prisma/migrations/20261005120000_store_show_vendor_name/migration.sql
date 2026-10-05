-- Per-store opt-in: show the provider (vendor) name/logo on the storefront.
ALTER TABLE "Store" ADD COLUMN "show_vendor_name" BOOLEAN NOT NULL DEFAULT false;
