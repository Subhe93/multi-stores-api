-- Old-slug redirects (plans/slug-wp-rules, WP `_wp_old_slug`): rows written
-- when a product, collection or root page slug changes get their own source,
-- so the merchant sees where they came from and imports never confuse them
-- with their own rows. Hand-written: enum value only, no data change.
ALTER TYPE "RedirectSource" ADD VALUE IF NOT EXISTS 'SLUG_CHANGE';
