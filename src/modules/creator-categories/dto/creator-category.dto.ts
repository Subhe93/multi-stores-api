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
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreatorCategoryMatchRule } from '@prisma/client';

export class CreatorCategoryTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
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
