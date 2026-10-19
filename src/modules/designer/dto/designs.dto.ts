import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DesignTemplateStatus } from '@prisma/client';

/** `POST designer/s/:slug/designs`. */
export class CreateDesignDto {
  @IsUUID()
  product_id!: string;

  @IsUUID()
  template_version_id!: string;

  /** Optional initial DesignStateV1 (texts only: photos go through the photo route). */
  @IsOptional()
  @IsObject()
  state?: Record<string, unknown>;

  /** M5.5 add-on selection `{key: qty}` (checked against the product's add-ons). */
  @IsOptional()
  @IsObject()
  addons?: Record<string, unknown> | null;

  /** M5.6 back side `{mode:'same'} | {mode:'other', template_id, template_version_id?, state}`. */
  @IsOptional()
  @IsObject()
  back?: Record<string, unknown> | null;
}

/** `PATCH designer/s/:slug/designs/:id`. */
export class UpdateDesignDto {
  @IsObject()
  state!: Record<string, unknown>;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  state_version!: number;

  /** M5.5: replaces the add-on selection when sent (`{}` / null clears it). */
  @IsOptional()
  @IsObject()
  addons?: Record<string, unknown> | null;

  /** M5.6: replaces the back side when sent (null clears it; absent = kept). */
  @IsOptional()
  @IsObject()
  back?: Record<string, unknown> | null;
}

/** Multipart fields of `POST designer/s/:slug/designs/:id/photos` (besides `file`). */
export class UploadDesignPhotoDto {
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  element_id!: string;

  /** M5.6: `back` puts the photo into a slot of the back template (default front). */
  @IsOptional()
  @IsIn(['front', 'back'])
  side?: 'front' | 'back';
}

// ── Creator templates (designer/my/...) ─────────────────────────────────────

export class CreateDesignTemplateDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  /** Optional initial spec (validated); a blank 500×700 template otherwise. */
  @IsOptional()
  @IsObject()
  spec?: Record<string, unknown>;
}

export class UpdateDesignTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsIn(Object.values(DesignTemplateStatus))
  status?: DesignTemplateStatus;
}

export class CreateTemplateVersionDto {
  @IsObject()
  spec!: Record<string, unknown>;
}

export class PublishTemplateDto {
  @IsUUID()
  version_id!: string;
}

export class ListDesignTemplatesQueryDto {
  @IsOptional()
  @IsIn(Object.values(DesignTemplateStatus))
  status?: DesignTemplateStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** `PUT designer/my/products/:productId`. */
export class PutProductDesignerDto {
  @IsBoolean()
  enabled!: boolean;

  @IsUUID()
  template_id!: string;
}

/** `PUT designer/my/products/:productId/addons` (validated by designer-addons.ts). */
export class PutProductAddonsDto {
  @IsObject()
  addons!: Record<string, unknown>;

  /**
   * M5.6: templates offered for the back side besides the product's own
   * (store's PUBLISHED templates). Absent = unchanged; `[]` = own only.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  back_template_ids?: string[];
}
