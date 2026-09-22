import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** Phrase an admin must type to confirm a restore. */
export const RESTORE_CONFIRM_PHRASE = 'RESTORE';

export const BACKUP_FREQUENCIES = ['DAILY', 'WEEKLY'] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

export const BACKUP_FILES = ['db', 'uploads'] as const;
export type BackupFileKind = (typeof BACKUP_FILES)[number];

export class CreateBackupDto {
  @IsOptional()
  @IsBoolean()
  include_uploads?: boolean;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class RestoreBackupDto {
  /** Must equal `RESTORE_CONFIRM_PHRASE`; checked in the service (400). */
  @IsString()
  @MaxLength(20)
  confirm: string;

  @IsOptional()
  @IsBoolean()
  restore_uploads?: boolean;
}

export class DownloadBackupQueryDto {
  @IsIn(BACKUP_FILES)
  file: BackupFileKind;
}

export class UpdateBackupSettingsDto {
  @IsOptional()
  @IsBoolean()
  backup_enabled?: boolean;

  @IsOptional()
  @IsIn(BACKUP_FREQUENCIES)
  backup_frequency?: BackupFrequency;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'backup_time must be HH:mm (24h)',
  })
  backup_time?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  backup_weekday?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  backup_retention?: number;

  @IsOptional()
  @IsBoolean()
  backup_include_uploads?: boolean;
}
