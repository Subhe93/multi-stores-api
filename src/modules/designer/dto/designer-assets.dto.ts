import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DesignAssetKind } from '@prisma/client';
import { TEMPLATE_ASSET_KINDS } from '../designer-assets.service';

/** Multipart fields of `POST designer/my/assets` (besides `file`). */
export class UploadTemplateAssetDto {
  @IsIn([...TEMPLATE_ASSET_KINDS])
  kind!: DesignAssetKind;

  /** Template the asset is for: its trim size drives the resolution checks. */
  @IsOptional()
  @IsUUID()
  template_id?: string;

  /** Upload/replace flow (U9): the asset this file supersedes (same kind). */
  @IsOptional()
  @IsUUID()
  replaces_asset_id?: string;
}

export class ListTemplateAssetsQueryDto {
  @IsOptional()
  @IsIn([...TEMPLATE_ASSET_KINDS])
  kind?: DesignAssetKind;

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

/**
 * Multipart fields of `POST designer/my/fonts` (besides `file`). All three
 * are optional: missing values are read from a Google-style file name.
 */
export class UploadFontDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  family?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  weight?: number;

  @IsOptional()
  @IsIn(['normal', 'italic'])
  style?: 'normal' | 'italic';
}
