import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsInt,
  IsObject,
  IsArray,
  Allow,
  ValidateNested,
  ValidateIf,
  Min,
  MaxLength,
  IsIn,
  IsUUID,
  Max,
  ArrayMaxSize,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ProductType,
  CustomizationType,
  ProductStatus,
  Prisma,
} from '@prisma/client';
import { UploadUrl } from '../../../common/uploads/upload-url.transform';

/** Allowed `condition` values of a product (feeds app); null = new. */
export const PRODUCT_CONDITIONS = ['new', 'refurbished', 'used'] as const;

export class ProductTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsString()
  slug: string;

  // Text columns; the caps bound SEO input (search engines show ~60 / ~160).
  @IsOptional()
  @IsString()
  @MaxLength(255)
  meta_title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  meta_desc?: string;

  // Short HTML summary (M4.4). On update, `undefined` keeps the stored value
  // for this locale (X19 carry-over), `null` or '' clears it.
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  short_description?: string | null;
}

export class ProductAttributeValueDto {
  @IsString()
  template_id: string;

  @Allow()
  value: Prisma.InputJsonValue;
}

// One variant in the product save payload. Carrying the existing `id` lets the
// server update in place instead of delete+recreate, which keeps variant ids
// stable (order items, carts, and custom-product links reference them).
export class ProductVariantSyncDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  price_adjustment?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  compare_at_price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  stock_quantity?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsObject()
  options: Record<string, string>;

  @IsOptional()
  @IsString()
  @UploadUrl()
  image_url?: string;
}

export class ProductImageSyncDto {
  @IsString()
  @UploadUrl()
  url: string;

  @IsOptional()
  @IsString()
  alt_text?: string;

  @IsOptional()
  @IsBoolean()
  is_featured?: boolean;
}

/**
 * One gallery video of a product save (product-video contract 3.1). The
 * business limits (3 per product, allowed hosts, own files) are checked by
 * ProductsService.syncVideos with coded errors; the DTO only guards shape.
 */
export class ProductVideoInputDto {
  /** Existing row id: the row is kept (created_at survives). */
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsIn(['file', 'youtube', 'vimeo'])
  kind!: 'file' | 'youtube' | 'vimeo';

  // @UploadUrl only rewrites URLs on our own hosts; YouTube/Vimeo URLs pass
  // through unchanged.
  @IsString()
  @MaxLength(2048)
  @UploadUrl()
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @UploadUrl()
  poster_url?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  alt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  duration_s?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  width?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  height?: number | null;

  /** Product-level images shown before this video; >= 1 (D6). */
  @IsInt()
  @Min(1)
  @Max(1000)
  position!: number;
}

/** One locale of a customer story (customer-stories contract 3.1). */
export class ProductStoryTranslationInputDto {
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  locale!: string;

  /** Plain text, never HTML (the storefront renders it as text). */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  quote?: string | null;

  /** Role / company / city. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subtitle?: string | null;
}

/**
 * One customer story of a product save (customer-stories contract 3.1). The
 * business rules (30 per product, allowed hosts, own uploads) are checked by
 * ProductsService.prepareStories with coded errors; the DTO only guards shape.
 */
export class ProductStoryInputDto {
  /** Existing row id: the row is kept. */
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsIn(['image', 'file', 'youtube', 'vimeo'])
  kind!: 'image' | 'file' | 'youtube' | 'vimeo';

  // @UploadUrl only rewrites URLs on our own hosts; YouTube/Vimeo URLs pass
  // through unchanged.
  @IsString()
  @MaxLength(2048)
  @UploadUrl()
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @UploadUrl()
  poster_url?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  duration_s?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  width?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  height?: number | null;

  @IsString()
  @MaxLength(80)
  name!: string;

  /** 1..5, or null for no rating (the DB has the same CHECK). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number | null;

  /** Owner-asserted "verified buyer" flag (EU Omnibus: real buyers only). */
  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => ProductStoryTranslationInputDto)
  translations!: ProductStoryTranslationInputDto[];
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

  // Tax class (platform class or one of the caller's store); null = the
  // default class of the scope. tax_exempt makes every rate lookup 0 %.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  tax_class_id?: string | null;

  @IsOptional()
  @IsBoolean()
  tax_exempt?: boolean;

  // Feed data (M5.6 feeds app). Every field is optional and nullable: on
  // update an absent key keeps the stored value (X19 carry-over), null or ''
  // clears it. gtin must be a GTIN-8/12/13/14 with a valid check digit
  // (checked in the service: PRODUCT_GTIN_INVALID). condition null = "new".
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(14)
  gtin?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(70)
  mpn?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(70)
  brand?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(191)
  google_product_category?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsIn(PRODUCT_CONDITIONS)
  condition?: string | null;

  @IsOptional()
  @IsBoolean()
  feed_excluded?: boolean;

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

  // Deprecated (tags rename, 2026-11-02): legacy ProductTag strings are no
  // longer written. Accepted during the deploy window so old clients do not
  // get a whitelist 400; the value is ignored by the service.
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

  // M6: the primary collection (breadcrumb / feed path). Must be one of
  // creator_category_ids; null/absent = auto (see resolvePrimaryCreatorCategory).
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  primary_creator_category_id?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductVariantSyncDto)
  variants?: ProductVariantSyncDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductImageSyncDto)
  images?: ProductImageSyncDto[];

  // Absent = stored videos untouched (older dashboards, importer); [] clears.
  // ArrayMaxSize is an abuse cap; the limit of 3 is VIDEO_LIMIT_EXCEEDED.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ProductVideoInputDto)
  videos?: ProductVideoInputDto[];

  // Absent = stored stories untouched (older dashboards, importer); [] clears.
  // ArrayMaxSize is an abuse cap; the limit of 30 is STORY_LIMIT_EXCEEDED.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ProductStoryInputDto)
  stories?: ProductStoryInputDto[];
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

  // Tax class (platform class or one of the caller's store); null = the
  // default class of the scope. tax_exempt makes every rate lookup 0 %.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  tax_class_id?: string | null;

  @IsOptional()
  @IsBoolean()
  tax_exempt?: boolean;

  // Feed data (M5.6 feeds app). Every field is optional and nullable: on
  // update an absent key keeps the stored value (X19 carry-over), null or ''
  // clears it. gtin must be a GTIN-8/12/13/14 with a valid check digit
  // (checked in the service: PRODUCT_GTIN_INVALID). condition null = "new".
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(14)
  gtin?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(70)
  mpn?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(70)
  brand?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(191)
  google_product_category?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsIn(PRODUCT_CONDITIONS)
  condition?: string | null;

  @IsOptional()
  @IsBoolean()
  feed_excluded?: boolean;

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

  // Deprecated (tags rename, 2026-11-02): legacy ProductTag strings are no
  // longer written. Accepted during the deploy window so old clients do not
  // get a whitelist 400; the value is ignored by the service.
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

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  primary_creator_category_id?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductVariantSyncDto)
  variants?: ProductVariantSyncDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductImageSyncDto)
  images?: ProductImageSyncDto[];

  // Absent = stored videos untouched (older dashboards, importer); [] clears.
  // ArrayMaxSize is an abuse cap; the limit of 3 is VIDEO_LIMIT_EXCEEDED.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ProductVideoInputDto)
  videos?: ProductVideoInputDto[];

  // Absent = stored stories untouched (older dashboards, importer); [] clears.
  // ArrayMaxSize is an abuse cap; the limit of 30 is STORY_LIMIT_EXCEEDED.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ProductStoryInputDto)
  stories?: ProductStoryInputDto[];
}
