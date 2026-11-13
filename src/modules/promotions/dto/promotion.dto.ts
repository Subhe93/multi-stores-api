import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsInt,
  IsArray,
  IsDateString,
  IsBoolean,
  ValidateNested,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PromotionType, PromotionLevel, PromotionStatus } from '@prisma/client';

export class PromotionTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class CreatePromotionDto {
  @IsEnum(PromotionType)
  type: PromotionType;

  @IsEnum(PromotionLevel)
  level: PromotionLevel;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  value: number;

  @IsOptional()
  conditions?: any; // { min_quantity, min_amount, product_ids, category_ids }

  @IsOptional()
  @IsString()
  coupon_code?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  usage_limit?: number;

  @IsDateString()
  starts_at: string;

  @IsOptional()
  @IsDateString()
  expires_at?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionTranslationDto)
  translations?: PromotionTranslationDto[];
}

export class UpdatePromotionDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  value?: number;

  @IsOptional()
  conditions?: any;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  usage_limit?: number;

  @IsOptional()
  @IsDateString()
  expires_at?: string;

  @IsOptional()
  @IsEnum(PromotionStatus)
  status?: PromotionStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionTranslationDto)
  translations?: PromotionTranslationDto[];
}

export class CouponLineTotalDto {
  @IsString()
  product_id: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount: number;
}

export class ValidateCouponDto {
  @IsString()
  coupon_code: string;

  // Required: a coupon is only valid on the store whose owner issued it.
  @IsString()
  store_id: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  subtotal?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  item_count?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  product_ids?: string[];

  /** Per-line totals (product or custom product id), for targeted coupons. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CouponLineTotalDto)
  line_totals?: CouponLineTotalDto[];

  /** Markets app: the cart's market key; its figures are in that currency. */
  @IsOptional()
  @IsString()
  market?: string;

  /** Markets app: a DRAFT market's preview host. */
  @IsOptional()
  @IsBoolean()
  preview?: boolean;
}

/**
 * Product-page coupon preview (link banner). Amounts are in the market
 * currency the shopper sees; the service converts them to base currency.
 */
export class CouponPreviewDto {
  // Public and unauthenticated: every string and number is bounded so
  // absurd input is rejected before it reaches a lookup.
  @IsString()
  @MaxLength(100)
  coupon_code: string;

  @IsString()
  @MaxLength(100)
  store_id: string;

  /** The product (or custom product) on the page, for targeted coupons. */
  @IsString()
  @MaxLength(100)
  product_id: string;

  /** Markets app: the storefront's market key. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  market?: string;

  /** Markets app: a DRAFT market's preview host. */
  @IsOptional()
  @IsBoolean()
  preview?: boolean;

  /** The line the discount is computed on (e.g. unit price x quantity). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1e9)
  @Type(() => Number)
  line_amount?: number;

  /** Current cart subtotal, to report whether min_amount is met. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1e9)
  @Type(() => Number)
  cart_subtotal?: number;

  /** Current cart item count, to report whether min_quantity is met. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  @Type(() => Number)
  item_count?: number;
}
