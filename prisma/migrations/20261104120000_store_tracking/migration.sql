-- Store tracking + cookie consent settings (Namez go-live 3.9).
-- Public vendor ids only; consent_required defaults to true so every existing
-- store keeps showing the cookie banner before any tracker loads.
ALTER TABLE "Store" ADD COLUMN "ga4_measurement_id" VARCHAR(32);
ALTER TABLE "Store" ADD COLUMN "meta_pixel_id" VARCHAR(32);
ALTER TABLE "Store" ADD COLUMN "tiktok_pixel_id" VARCHAR(64);
ALTER TABLE "Store" ADD COLUMN "consent_required" BOOLEAN NOT NULL DEFAULT true;
