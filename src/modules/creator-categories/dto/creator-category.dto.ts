import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsArray,
  IsEnum,
  ValidateNested,
  Min,
  ArrayUnique,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CreatorCategoryMatchRule,
  CreatorCategoryVisibility,
} from '@prisma/client';

export class CreatorCategoryTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  name: string;

  // Short description: shown in the hero under the collection title.
  @IsOptional()
  @IsString()
  description?: string;

  // M6.2: long SEO description (HTML, sanitised on write) rendered below the
  // products on the collection page. Same carry-over semantics as the SEO
  // fields: `undefined` keeps the stored value, `null`/'' clears it.
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  long_description?: string | null;

  // SEO overrides (M4.4). On update, `undefined` keeps the stored value of
  // this locale (X19 carry-over); `null` or '' clears it.
  @IsOptional()
  @IsString()
  meta_title?: string | null;

  @IsOptional()
  @IsString()
  meta_desc?: string | null;
}

export class CreateCreatorCategoryDto {
  @IsString()
  slug: string;

  @IsOptional()
  @IsString()
  parent_id?: string;

  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  @IsOptional()
  @IsEnum(CreatorCategoryMatchRule)
  match_rule?: CreatorCategoryMatchRule;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  match_tags?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  // Leave the collection out of the sitemap and noindex it while it has no
  // published products (M4.4).
  @IsOptional()
  @IsBoolean()
  noindex_when_empty?: boolean;

  // M6.3: PUBLIC (default) = storefront collection; INTERNAL = flat label
  // that never becomes a storefront page, a parent, a child or a primary.
  @IsOptional()
  @IsEnum(CreatorCategoryVisibility)
  visibility?: CreatorCategoryVisibility;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatorCategoryTranslationDto)
  translations: CreatorCategoryTranslationDto[];

  // Optional initial product list when match_rule = MANUAL
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  product_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  custom_product_ids?: string[];
}

export class UpdateCreatorCategoryDto {
  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  parent_id?: string | null;

  @IsOptional()
  @IsString()
  thumbnail_url?: string | null;

  @IsOptional()
  @IsEnum(CreatorCategoryMatchRule)
  match_rule?: CreatorCategoryMatchRule;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  match_tags?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  // Leave the collection out of the sitemap and noindex it while it has no
  // published products (M4.4).
  @IsOptional()
  @IsBoolean()
  noindex_when_empty?: boolean;

  // M6.3: switching to INTERNAL requires no children; the collection's
  // parent is cleared and any product primary pointing at it is reset.
  @IsOptional()
  @IsEnum(CreatorCategoryVisibility)
  visibility?: CreatorCategoryVisibility;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatorCategoryTranslationDto)
  translations?: CreatorCategoryTranslationDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  product_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  custom_product_ids?: string[];
}

export class ReorderCreatorCategoriesDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  ids: string[];
}
