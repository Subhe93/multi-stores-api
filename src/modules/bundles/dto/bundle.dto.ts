import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsInt,
  IsArray,
  ValidateNested,
  ArrayMinSize,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BundleDiscountType, BundleStatus } from '@prisma/client';

export class BundleTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  name: string;
}

export class BundleOfferTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  sticker_text?: string;
}

export class BundleOfferDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @IsEnum(BundleDiscountType)
  discount_type: BundleDiscountType;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  discount_value: number;

  @IsOptional()
  @IsString()
  external_ref?: string;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BundleOfferTranslationDto)
  translations: BundleOfferTranslationDto[];
}

export class CreateBundleDto {
  @IsOptional()
  @IsEnum(BundleStatus)
  status?: BundleStatus;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BundleTranslationDto)
  translations: BundleTranslationDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BundleOfferDto)
  offers: BundleOfferDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  product_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  custom_product_ids?: string[];
}

export class UpdateBundleDto {
  @IsOptional()
  @IsEnum(BundleStatus)
  status?: BundleStatus;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BundleTranslationDto)
  translations?: BundleTranslationDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BundleOfferDto)
  offers?: BundleOfferDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  product_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  custom_product_ids?: string[];
}
