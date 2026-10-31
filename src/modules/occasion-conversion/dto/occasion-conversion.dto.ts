import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ConversionInputDto {
  @IsString()
  @MaxLength(80)
  @Matches(SLUG, { message: 'parent_slug must be a collection slug' })
  parent_slug!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(SLUG, { each: true })
  merge_descendant_products?: string[];

  @IsOptional()
  @IsBoolean()
  include_parent?: boolean;

  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class ApplyConversionDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ConversionInputDto)
  input!: ConversionInputDto;

  /** Fingerprint of the dry run being applied (409 OCCASION_PLAN_STALE otherwise). */
  @IsString()
  @MaxLength(64)
  fingerprint!: string;
}

export class RollbackConversionDto {
  @IsUUID()
  conversion_id!: string;
}
