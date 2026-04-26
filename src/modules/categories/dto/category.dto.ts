import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCategoryDto {
  @IsString()
  slug: string;

  @IsOptional()
  @IsString()
  parent_id?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CategoryTranslationDto)
  translations: CategoryTranslationDto[];
}

export class CategoryTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  parent_id?: string;

  @IsOptional()
  @IsString()
  icon?: string;

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
  @Type(() => CategoryTranslationDto)
  translations?: CategoryTranslationDto[];
}

export class LinkAttributesDto {
  @IsArray()
  @IsString({ each: true })
  template_ids: string[];
}
