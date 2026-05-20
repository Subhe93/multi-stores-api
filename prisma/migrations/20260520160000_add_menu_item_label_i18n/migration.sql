-- Per-locale labels for menu items. `label` stays as the primary-locale
-- (and fallback) value; `label_i18n` holds overrides keyed by locale, e.g.
-- { "ar": "الرئيسية" }. Storefront resolves label_i18n[locale] ?? label.

ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "label_i18n" JSONB NOT NULL DEFAULT '{}';
