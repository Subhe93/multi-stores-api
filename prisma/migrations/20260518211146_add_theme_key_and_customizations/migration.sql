-- AlterTable: introduce structured theme selection on Store.
-- theme_key references a code-defined theme registry in the storefront.
-- theme_customizations holds creator overrides for theme tokens (colors, fonts, etc.).
-- The legacy theme_config column is retained for backward compatibility while the
-- storefront migrates to the new theme system.
ALTER TABLE "Store"
  ADD COLUMN "theme_key" TEXT NOT NULL DEFAULT 'minimal',
  ADD COLUMN "theme_customizations" JSONB NOT NULL DEFAULT '{}';
