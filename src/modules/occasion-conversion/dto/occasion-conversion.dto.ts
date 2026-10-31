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

// Collection slugs follow WordPress sanitize_title (Unicode letters, `_`,
// up to 200 encoded bytes), so any collection can be named; the planner
// normalizes the value (decode, NFC, lower case) before matching.
const SLUG_INPUT_MAX = 1000;
// No '/', no whitespace or control characters: one path segment.
// eslint-disable-next-line no-control-regex
const SLUG_SEGMENT = /^[^\s/\u0000-\u001f\u007f]+$/u;

export class ConversionInputDto {
  @IsString()
  @MaxLength(SLUG_INPUT_MAX)
  @Matches(SLUG_SEGMENT, { message: 'parent_slug must be a collection slug' })
  parent_slug!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(SLUG_INPUT_MAX, { each: true })
  @Matches(SLUG_SEGMENT, { each: true })
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
