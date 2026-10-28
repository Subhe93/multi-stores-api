import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsEnum,
  IsIn,
  IsObject,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { StoreType } from '@prisma/client';
import { SUPPORTED_CURRENCIES } from '../../../common/money/currency.util';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MESSAGE =
  'slug must be lowercase letters, digits, and hyphens (no leading/trailing hyphen)';

// Accepts an empty string (means "clear the domain") OR a valid hostname like
// shop.example.com. Apex domains (example.com) are allowed too, but the user
// must point a CNAME to the platform — they're responsible for DNS setup.
const DOMAIN_REGEX =
  /^$|^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const DOMAIN_MESSAGE =
  'custom_domain must be a valid domain like shop.example.com';

// Tracking ids (Namez go-live 3.9). An empty string clears the id; the
// service stores NULL (and upper-cases the GA4/TikTok ids, which is why the
// regexes are case-insensitive). Public ids only, so no secret ever lands here.
export const GA4_MEASUREMENT_ID_REGEX = /^$|^G-[A-Z0-9]{4,}$/i;
export const GA4_MEASUREMENT_ID_MESSAGE =
  'ga4_measurement_id must look like G-XXXXXXXXXX';
export const META_PIXEL_ID_REGEX = /^$|^[0-9]{5,32}$/;
export const META_PIXEL_ID_MESSAGE = 'meta_pixel_id must be digits only';
export const TIKTOK_PIXEL_ID_REGEX = /^$|^[A-Z0-9]{8,64}$/i;
export const TIKTOK_PIXEL_ID_MESSAGE =
  'tiktok_pixel_id must be letters and digits only';

export class CreateStoreDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  slug: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  primary_locale?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secondary_locales?: string[];

  // MARKETPLACE (default) or INDEPENDENT (creator-only products, direct
  // charges). Chosen once at creation — creators cannot change it afterwards;
  // only an admin can via PUT /stores/by-creator/:creatorId.
  @IsOptional()
  @IsEnum(StoreType)
  store_type?: StoreType;
}

export class UpdateStoreDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(SLUG_REGEX, { message: SLUG_MESSAGE })
  slug?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  logo_url?: string;

  @IsOptional()
  @IsString()
  favicon_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(253)
  @Matches(DOMAIN_REGEX, { message: DOMAIN_MESSAGE })
  custom_domain?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  // Toggle storefront caching for this store. When false the storefront is
  // served always-fresh (uncached).
  @IsOptional()
  @IsBoolean()
  cache_enabled?: boolean;

  // Cash on delivery availability at checkout (off by default).
  @IsOptional()
  @IsBoolean()
  cod_enabled?: boolean;

  // Marketplace stores only: show the provider (vendor) name/logo on the
  // storefront for resold products. Off by default.
  @IsOptional()
  @IsBoolean()
  show_vendor_name?: boolean;

  // Presentment currency. Independent stores only — the service rejects it for
  // marketplace stores, which are charged on the platform account. Null/empty
  // clears it back to the platform default.
  @IsOptional()
  @IsString()
  @IsIn([...SUPPORTED_CURRENCIES, ''], {
    message: 'currency must be a supported ISO-4217 code',
  })
  currency?: string;

  // Checkout behaviour overrides (M5.1). Validated and normalized by the
  // service (modules/stores/checkout-settings.ts); null clears them back to
  // the platform defaults.
  @IsOptional()
  @IsObject()
  checkout_settings?: Record<string, unknown> | null;

  // Tracking + cookie consent (Namez go-live 3.9). Empty string or null
  // clears an id. The storefront only loads a tracker whose id is set.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(GA4_MEASUREMENT_ID_REGEX, { message: GA4_MEASUREMENT_ID_MESSAGE })
  ga4_measurement_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(META_PIXEL_ID_REGEX, { message: META_PIXEL_ID_MESSAGE })
  meta_pixel_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(TIKTOK_PIXEL_ID_REGEX, { message: TIKTOK_PIXEL_ID_MESSAGE })
  tiktok_pixel_id?: string | null;

  // false = load the trackers without asking (the creator takes the legal
  // responsibility); true (default) = cookie banner first.
  @IsOptional()
  @IsBoolean()
  consent_required?: boolean;
}

// Admin-only store update: also allows switching the store type. The creator
// update endpoint keeps using UpdateStoreDto, where store_type is rejected by
// the global forbidNonWhitelisted validation.
export class AdminUpdateStoreDto extends UpdateStoreDto {
  @IsOptional()
  @IsEnum(StoreType)
  store_type?: StoreType;
}

export class UpdateThemeDto {
  @IsObject()
  theme_config: Record<string, any>;
}

export class UpdateThemeSelectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: 'theme_key must be lowercase letters, digits, and hyphens',
  })
  theme_key?: string;

  @IsOptional()
  @IsObject()
  theme_customizations?: Record<string, any>;

  // When true, applying the theme resets the store to the theme's defaults:
  // clears theme_customizations and strips brand overrides (colours, fonts,
  // typography) from theme_config, while preserving non-brand config such as
  // socials, contact, SEO and translations.
  @IsOptional()
  @IsBoolean()
  reset_customizations?: boolean;
}

export class UpdateLanguageDto {
  @IsOptional()
  @IsString()
  primary_locale?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secondary_locales?: string[];

  @IsOptional()
  @IsBoolean()
  auto_translate?: boolean;
}
