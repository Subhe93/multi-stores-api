import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductStatus, ImportMode, PricingType } from '@prisma/client';

// ── Sub-DTOs ──────────────────────────────────────────────

export class CustomProductTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  slug: string;
}

export class CustomProductVariantDto {
  @IsString()
  variant_id: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  custom_price?: number;
}

export class CustomProductFieldValueDto {
  @IsString()
  custom_field_id: string;

  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  @IsString()
  file_url?: string;
}

// ── Create DTO ────────────────────────────────────────────

export class CreateCustomProductDto {
  @IsString()
  product_id: string;

  @IsEnum(ImportMode)
  import_mode: ImportMode;

  @IsEnum(PricingType)
  pricing_type: PricingType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  final_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  margin_amount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomProductVariantDto)
  selected_variants?: CustomProductVariantDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomProductFieldValueDto)
  field_values?: CustomProductFieldValueDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mockup_image_urls?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomProductTranslationDto)
  translations: CustomProductTranslationDto[];
}

// ── Update DTO ────────────────────────────────────────────

export class UpdateCustomProductDto {
  @IsOptional()
  @IsEnum(PricingType)
  pricing_type?: PricingType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  final_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  margin_amount?: number;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomProductVariantDto)
  selected_variants?: CustomProductVariantDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomProductFieldValueDto)
  field_values?: CustomProductFieldValueDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mockup_image_urls?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomProductTranslationDto)
  translations?: CustomProductTranslationDto[];
}
