-- Shipping: per-zone opt-in to offer only the free method(s) once a method's
-- free_threshold is met (WooCommerce "Hide shipping methods", hide_all mode).
-- Additive: defaults to false, so every existing zone quotes exactly as before.
ALTER TABLE "ShippingZone" ADD COLUMN "hide_others_when_free" BOOLEAN NOT NULL DEFAULT false;
