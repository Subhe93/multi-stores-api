import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { TaxBasis, TaxPricingMode } from '@prisma/client';

const LOCALIZED_MAX = 60;

/**
 * `{ "en": "VAT", "sv": "Moms" }`: a non-empty object whose values are
 * non-empty strings of at most 60 characters, keyed by short locale codes.
 */
export function IsLocalizedText(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isLocalizedText',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be an object of locale → text (strings up to ${LOCALIZED_MAX} characters)`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
          }
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.length === 0) return false;
          return entries.every(
            ([k, v]) =>
              /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(k) &&
              typeof v === 'string' &&
              v.trim().length > 0 &&
              v.length <= LOCALIZED_MAX,
          );
        },
      },
    });
  };
}

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

// ── Classes ──────────────────────────────────────────────────────────────────

export class CreateTaxClassDto {
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/, {
    message: 'key must be a lowercase slug (letters, digits, - and _)',
  })
  key: string;

  @IsLocalizedText()
  name: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  @Type(() => Number)
  sort_order?: number;
}

export class UpdateTaxClassDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/, {
    message: 'key must be a lowercase slug (letters, digits, - and _)',
  })
  key?: string;

  @IsOptional()
  @IsLocalizedText()
  name?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  @Type(() => Number)
  sort_order?: number;
}

// ── Rates ────────────────────────────────────────────────────────────────────

export class CreateTaxRateDto {
  @IsString()
  tax_class_id: string;

  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be an ISO 3166-1 alpha-2 code',
  })
  country: string;

  @IsOptional()
  @Transform(upper)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(10)
  @Matches(/^[A-Z0-9-]+$/, { message: 'region must be a state/province code' })
  region?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9 ]+\*?$|^[A-Za-z0-9 ]+-[A-Za-z0-9 ]+$/, {
    message:
      'postcode_pattern must be a postcode, a prefix ending in * or a range like 10000-19999',
  })
  postcode_pattern?: string | null;

  @IsInt()
  @Min(0)
  @Max(10_000)
  @Type(() => Number)
  rate_bp: number;

  @IsLocalizedText()
  label: Record<string, string>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  applies_to_shipping?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateTaxRateDto {
  @IsOptional()
  @IsString()
  tax_class_id?: string;

  @IsOptional()
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be an ISO 3166-1 alpha-2 code',
  })
  country?: string;

  @IsOptional()
  @Transform(upper)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(10)
  @Matches(/^[A-Z0-9-]+$/, { message: 'region must be a state/province code' })
  region?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9 ]+\*?$|^[A-Za-z0-9 ]+-[A-Za-z0-9 ]+$/, {
    message:
      'postcode_pattern must be a postcode, a prefix ending in * or a range like 10000-19999',
  })
  postcode_pattern?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  @Type(() => Number)
  rate_bp?: number;

  @IsOptional()
  @IsLocalizedText()
  label?: Record<string, string>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  applies_to_shipping?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ListTaxRatesQueryDto {
  @IsOptional()
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be an ISO 3166-1 alpha-2 code',
  })
  country?: string;

  /** Class id or key. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  class?: string;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export class UpdatePlatformTaxSettingsDto {
  @IsOptional()
  @IsEnum(TaxPricingMode)
  default_tax_pricing_mode?: TaxPricingMode;

  @IsOptional()
  @Transform(upper)
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'platform_tax_country must be an ISO 3166-1 alpha-2 code',
  })
  platform_tax_country?: string | null;

  @IsOptional()
  @IsBoolean()
  platform_oss_registered?: boolean;
}

export class UpdateStoreTaxSettingsDto {
  @IsOptional()
  @IsEnum(TaxPricingMode)
  pricing_mode?: TaxPricingMode;

  @IsOptional()
  @IsEnum(TaxBasis)
  basis?: TaxBasis;

  @IsOptional()
  @Transform(upper)
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'tax_country must be an ISO 3166-1 alpha-2 code',
  })
  tax_country?: string | null;

  @IsOptional()
  @IsBoolean()
  oss_registered?: boolean;

  @IsOptional()
  @IsBoolean()
  use_platform_tax_rates?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsString()
  shipping_tax_class_id?: string | null;

  @IsOptional()
  @IsBoolean()
  display_prices_incl_tax?: boolean;
}

// ── Report ───────────────────────────────────────────────────────────────────

export class TaxReportQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @IsString()
  store_id?: string;

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
