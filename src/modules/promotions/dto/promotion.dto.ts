import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsInt,
  IsArray,
  IsDateString,
  ValidateNested,
  Min,
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

export class ValidateCouponDto {
  @IsString()
  coupon_code: string;

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
}
