import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PageStatus, PageType, StaticPageType } from '@prisma/client';
import { UploadUrlsInJson } from '../../../common/uploads/upload-url.transform';

// Slugs follow WordPress sanitize_title (Unicode letters kept, up to 200
// encoded bytes): the service sanitizes and dedupes whatever is sent and
// returns the final slug, so only the raw input length is bounded here.
const SLUG_INPUT_MAX = 1000;

// ── Pages ────────────────────────────────────────────────

export class PageTranslationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(5)
  locale: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  meta_title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  meta_description?: string;
}

export class CreatePageDto {
  @IsEnum(PageType)
  type: PageType;

  @IsOptional()
  @IsEnum(StaticPageType)
  static_kind?: StaticPageType;

  @IsOptional()
  @IsString()
  @MaxLength(SLUG_INPUT_MAX)
  slug?: string;

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
  @MinLength(1)
  @MaxLength(SLUG_INPUT_MAX)
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
  @IsObject()
  @UploadUrlsInJson()
  seo?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PageTranslationDto)
  translations?: PageTranslationDto[];
}

// ── Sections ─────────────────────────────────────────────

export class SectionTranslationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(5)
  locale: string;

  @IsObject()
  @UploadUrlsInJson()
  content: Record<string, unknown>;
}

export class CreateSectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  section_key: string;

  @IsOptional()
  @IsObject()
  @UploadUrlsInJson()
  settings?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  // Layout container (layout-row / -column / -grid) to add the section
  // into; absent or null = root.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parent_id?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SectionTranslationDto)
  translations?: SectionTranslationDto[];
}

export class UpdateSectionDto {
  @IsOptional()
  @IsObject()
  @UploadUrlsInJson()
  settings?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  is_hidden?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SectionTranslationDto)
  translations?: SectionTranslationDto[];
}

export class ReorderSectionsDto {
  @IsArray()
  @IsString({ each: true })
  section_ids: string[];
}

export class SectionTreeItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id: string;

  // Absent or null = root.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parent_id?: string | null;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order: number;
}

/** Full section list of a page with each section's parent + sibling order. */
export class ReorderSectionTreeDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => SectionTreeItemDto)
  items: SectionTreeItemDto[];
}

// ── Publish / versions ──────────────────────────────────

export class PublishPageDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}
