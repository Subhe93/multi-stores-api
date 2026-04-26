import { IsString, IsOptional, IsEnum, IsArray } from 'class-validator';

export enum TranslatableEntity {
  PRODUCT = 'product',
  CATEGORY = 'category',
  CUSTOM_PRODUCT = 'custom_product',
  PROMOTION = 'promotion',
  STATIC_PAGE = 'static_page',
  CUSTOM_FIELD = 'custom_field',
}

export class AutoTranslateDto {
  @IsEnum(TranslatableEntity)
  entity_type: TranslatableEntity;

  @IsString()
  entity_id: string;

  @IsString()
  source_locale: string;

  @IsString()
  target_locale: string;
}

export class BulkTranslateDto {
  @IsString()
  store_id: string;

  @IsString()
  target_locale: string;

  @IsOptional()
  @IsString()
  source_locale?: string;

  // Which entity types to translate: 'products' | 'custom_products' | 'designs' | 'pages' | 'all'
  // Defaults to ['products'] if not specified
  @IsOptional()
  @IsArray()
  entity_types?: string[];
}
