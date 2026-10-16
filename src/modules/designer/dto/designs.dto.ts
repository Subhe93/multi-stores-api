import { Type } from 'class-transformer';
import {
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
}

/** `PATCH designer/s/:slug/designs/:id`. */
export class UpdateDesignDto {
  @IsObject()
  state!: Record<string, unknown>;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  state_version!: number;
}

/** Multipart fields of `POST designer/s/:slug/designs/:id/photos` (besides `file`). */
export class UploadDesignPhotoDto {
  @IsString()
  @Matches(/^[a-z0-9_-]{1,32}$/)
  element_id!: string;
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
