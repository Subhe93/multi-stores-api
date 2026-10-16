import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ImportItemAction,
  ImportItemPhase,
  ImportLogLevel,
  ImportRunStatus,
} from '@prisma/client';
import { BUNDLE_DIR_NAME_RE } from '../runs/bundle-store';

/** Multipart fields of `POST importer/my/runs` (the files come as `files`). */
export class CreateImportRunDto {
  @IsUUID()
  source_id: string;

  /** Run options as a JSON string (§12.2); validated by `normalizeRunOptions`. */
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  options?: string;
}

export class ConfirmRunDto {
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/)
  plan_fingerprint: string;
}

export class PageQueryDto {
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

export class RunListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(ImportRunStatus)
  status?: ImportRunStatus;

  @IsOptional()
  @IsUUID()
  source_id?: string;
}

/** Admin: start a run from an extracted bundle directory on the server. */
export class DirectoryRunDto {
  @IsUUID()
  source_id: string;

  /** Directory below IMPORTER_BUNDLE_DIR_ROOT, as a relative name (`namez/2026-10-15`). */
  @IsString()
  @MaxLength(500)
  @Matches(BUNDLE_DIR_NAME_RE, {
    message: 'directory must be a relative name below the bundle root',
  })
  directory: string;

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

export class RunItemsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(ImportItemPhase)
  phase?: ImportItemPhase;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  entity_type?: string;

  @IsOptional()
  @IsEnum(ImportItemAction)
  action?: ImportItemAction;
}

export class RunLogsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(ImportLogLevel)
  level?: ImportLogLevel;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;
}

export class RunReportQueryDto {
  @IsOptional()
  @IsIn(['PLAN', 'APPLY', 'ROLLBACK'])
  phase?: ImportItemPhase;
}
