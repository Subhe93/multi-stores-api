import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ImportSourceKind } from '@prisma/client';

export class CreateImportSourceDto {
  @IsEnum(ImportSourceKind)
  kind: ImportSourceKind;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  /** Shop address (`https://namez.se` or `namez.se`); stored as a lower-case host. */
  @IsString()
  @MaxLength(300)
  site_url: string;

  /** Hosts rewritten to the site host (e.g. an old domain). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  host_aliases?: string[];

  /** `{product_base, category_base, tag_base, locale, currency, uploads_path}` (legacy bundles). */
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  /** WooCommerce REST Read key (write-only, stored encrypted). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  consumer_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  consumer_secret?: string;
}

export class UpdateImportSourceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  site_url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  host_aliases?: string[];

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  consumer_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  consumer_secret?: string;
}
