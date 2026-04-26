import { IsString, IsOptional, IsEnum, IsArray, ValidateNested, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { StaticPageType, PageStatus } from '@prisma/client';

export class PageTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  content?: string;
}

export class CreatePageDto {
  @IsEnum(StaticPageType)
  type: StaticPageType;

  @IsString()
  slug: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PageTranslationDto)
  translations?: PageTranslationDto[];
}

export class UpdatePageDto {
  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsEnum(PageStatus)
  status?: PageStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PageTranslationDto)
  translations?: PageTranslationDto[];
}
