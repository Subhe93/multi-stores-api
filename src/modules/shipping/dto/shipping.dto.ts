import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsInt,
  IsArray,
  IsEnum,
  IsObject,
  IsNotEmpty,
  ValidateNested,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ShippingMethodType } from '@prisma/client';

// Bounds that keep dashboard input sane: nothing ships in more than a year,
// and sort orders are small integers (they only order a handful of methods).
const MAX_ESTIMATED_DAYS = 365;
const MAX_SORT_ORDER = 1000;

/** Trim string input before validation (so "   " fails @IsNotEmpty). */
const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

// ── Methods ─────────────────────────────────────────────────────────────────

export class CreateShippingMethodDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  // Per-locale display names keyed by locale code, e.g. { "sv": "Standardfrakt" }.
  // Validated as a plain object; the service keeps only string values.
  @IsOptional()
  @IsObject()
  translations?: Record<string, string>;

  @IsOptional()
  @IsEnum(ShippingMethodType)
  type?: ShippingMethodType;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  base_cost: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  per_item_cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  free_threshold?: number | null;

  @IsInt()
  @Min(0)
  @Max(MAX_ESTIMATED_DAYS)
  @Type(() => Number)
  estimated_days_min: number;

  @IsInt()
  @Min(0)
  @Max(MAX_ESTIMATED_DAYS)
  @Type(() => Number)
  estimated_days_max: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SORT_ORDER)
  @Type(() => Number)
  sort_order?: number;
}

export class UpdateShippingMethodDto {
  @IsOptional()
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  // Nullable on purpose: sending null clears every translation.
  @IsOptional()
  @IsObject()
  translations?: Record<string, string> | null;

  @IsOptional()
  @IsEnum(ShippingMethodType)
  type?: ShippingMethodType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  base_cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  per_item_cost?: number;

  // Nullable on purpose: sending null clears the free-shipping threshold.
  // @IsOptional also skips validation for null, so null passes through as-is.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  free_threshold?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_ESTIMATED_DAYS)
  @Type(() => Number)
  estimated_days_min?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_ESTIMATED_DAYS)
  @Type(() => Number)
  estimated_days_max?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SORT_ORDER)
  @Type(() => Number)
  sort_order?: number;
}

// ── Zones ───────────────────────────────────────────────────────────────────

export class CreateShippingZoneDto {
  @IsString()
  name: string;

  @IsArray()
  @IsString({ each: true })
  countries: string[]; // ISO codes

  // Legacy single-method cost fields. Optional since methods took over the
  // pricing (the dashboard no longer sends them); they default to a free,
  // same-day zone and only matter for a zone that has no methods yet.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  base_cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  per_item_cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  free_threshold?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  estimated_days_min?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  estimated_days_max?: number;

  // Methods to create together with the zone.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShippingMethodDto)
  methods?: CreateShippingMethodDto[];
}

export class UpdateShippingZoneDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  countries?: string[]; // ISO codes

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  base_cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  per_item_cost?: number;

  // Nullable on purpose: sending null clears the free-shipping threshold.
  // @IsOptional also skips validation for null, so null passes through as-is.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  free_threshold?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  estimated_days_min?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  estimated_days_max?: number;
}

// ── Profiles ────────────────────────────────────────────────────────────────

export class CreateShippingProfileDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShippingZoneDto)
  zones?: CreateShippingZoneDto[];
}

// ── Quotes ──────────────────────────────────────────────────────────────────

export class EstimateShippingDto {
  @IsArray()
  @IsString({ each: true })
  product_ids: string[];

  @IsString()
  country_code: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  item_count: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  subtotal: number;

  // Locale the method names are resolved in (translations[locale] → name).
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
}

export class CalculateShippingDto {
  @IsString()
  profile_id: string;

  @IsString()
  country_code: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  item_count: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  subtotal: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
}
