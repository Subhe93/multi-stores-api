import { IsString, IsOptional, IsBoolean, IsArray, IsObject, Matches, MinLength, MaxLength } from 'class-validator';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MESSAGE = 'slug must be lowercase letters, digits, and hyphens (no leading/trailing hyphen)';

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
  custom_domain?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  // Toggle storefront caching for this store. When false the storefront is
  // served always-fresh (uncached).
  @IsOptional()
  @IsBoolean()
  cache_enabled?: boolean;
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
