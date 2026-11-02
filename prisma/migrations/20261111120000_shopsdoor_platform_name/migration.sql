-- Rebrand: the platform is now ShopsDoor. New installs default to the new
-- name, and rows still carrying the old default are renamed. A name the admin
-- changed to anything else is left untouched.
ALTER TABLE "PlatformConfig" ALTER COLUMN "platform_name" SET DEFAULT 'ShopsDoor';
UPDATE "PlatformConfig" SET platform_name = 'ShopsDoor' WHERE platform_name = 'Multi Stores';
