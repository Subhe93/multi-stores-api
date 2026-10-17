import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RedirectSource } from '@prisma/client';
import { REDIRECT_STATUS_CODES } from '../redirect-path.util';

// Raw input may be longer than the normalised 1024-char key (percent-encoding);
// the service validates the normalised value.
const RAW_PATH_MAX = 4096;

export class CreateRedirectDto {
  @IsString()
  @MaxLength(RAW_PATH_MAX)
  from_path: string;

  @IsString()
  @MaxLength(RAW_PATH_MAX)
  to_path: string;

  @IsOptional()
  @IsIn([...REDIRECT_STATUS_CODES])
  status_code?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

/** `POST redirects/my/bulk`: the CSV text (`from_path,to_path[,status]` per line). */
export class BulkRedirectDto {
  // 5000 lines of two 4096-char paths plus separators.
  @IsString()
  @MaxLength(5000 * (2 * RAW_PATH_MAX + 8))
  csv: string;
}

export class UpdateRedirectDto {
  @IsOptional()
  @IsString()
  @MaxLength(RAW_PATH_MAX)
  from_path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(RAW_PATH_MAX)
  to_path?: string;

  @IsOptional()
  @IsIn([...REDIRECT_STATUS_CODES])
  status_code?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class RedirectListQueryDto {
  /** Substring of from_path or to_path (case-insensitive). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsEnum(RedirectSource)
  source?: RedirectSource;

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

export class TestRedirectDto {
  @IsString()
  @MaxLength(RAW_PATH_MAX)
  path: string;
}
