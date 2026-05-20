import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsArray,
  Allow,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductType, CustomizationType, ProductStatus } from '@prisma/client';

export class ProductTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsString()
  slug: string;

  @IsOptional()
  @IsString()
  meta_title?: string;

  @IsOptional()
  @IsString()
  meta_desc?: string;
}

export class ProductAttributeValueDto {
  @IsString()
  template_id: string;

  @Allow()
  value: any;
}

export class CreateProductDto {
  @IsString()
  category_id: string;

  @IsEnum(ProductType)
  product_type: ProductType;

  @IsOptional()
  @IsEnum(CustomizationType)
  customization_type?: CustomizationType;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  base_price: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  compare_at_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  cost_price?: number;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsBoolean()
  track_inventory?: boolean;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  stock_quantity?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  weight?: number;

  @IsOptional()
  @IsString()
  weight_unit?: string;

  @IsOptional()
  @Allow()
  variant_option_config?: any;

  @IsOptional()
  @IsString()
  shipping_profile_id?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductTranslationDto)
  translations: ProductTranslationDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeValueDto)
  attributes?: ProductAttributeValueDto[];

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bundle_ids?: string[];

  // Creator's own collections (Shopify-style). Ignored when caller is a Provider.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  creator_category_ids?: string[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  category_id?: string;

  @IsOptional()
  @IsEnum(ProductType)
  product_type?: ProductType;

  @IsOptional()
  @IsEnum(CustomizationType)
  customization_type?: CustomizationType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  base_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  compare_at_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  cost_price?: number;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsBoolean()
  track_inventory?: boolean;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  stock_quantity?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  weight?: number;

  @IsOptional()
  @IsString()
  weight_unit?: string;

  @IsOptional()
  @Allow()
  variant_option_config?: any;

  @IsOptional()
  @IsString()
  shipping_profile_id?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsBoolean()
  is_featured?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductTranslationDto)
  translations?: ProductTranslationDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeValueDto)
  attributes?: ProductAttributeValueDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bundle_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  creator_category_ids?: string[];
}
