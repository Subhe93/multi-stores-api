import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const CONSENT_ACTIONS = [
  'accept_all',
  'reject_all',
  'save',
  'external_media_grant',
  'external_media_revoke',
  'migrated',
] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];

export const CONSENT_SOURCES = [
  'banner',
  'dialog',
  'facade',
  'migration',
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_TRACKER_VENDORS = [
  'ga4',
  'clarity',
  'meta',
  'tiktok',
] as const;

/**
 * `POST /storefront/:slug/consent` body (consent v2 §5.2). The global pipe
 * runs with whitelist + forbidNonWhitelisted, so any extra field is a 400.
 * `analytics` / `marketing` / `external_media` are boolean or null (null =
 * not offered / not part of this decision).
 */
export class LogConsentDto {
  @IsUUID('4')
  event_id!: string;

  @IsUUID('4')
  consent_id!: string;

  @IsIn(CONSENT_ACTIONS)
  action!: ConsentAction;

  @IsIn(CONSENT_SOURCES)
  source!: ConsentSource;

  @IsOptional()
  @IsBoolean()
  analytics?: boolean | null;

  @IsOptional()
  @IsBoolean()
  marketing?: boolean | null;

  @IsOptional()
  @IsBoolean()
  external_media?: boolean | null;

  @IsString()
  @Matches(/^[0-9]{1,4}$/)
  consent_version!: string;

  @IsArray()
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(CONSENT_TRACKER_VENDORS, { each: true })
  vendors!: string[];

  @IsString()
  @Matches(/^([a-f0-9]{64}|legacy|unavailable|facade)$/)
  text_hash!: string;

  @IsString()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  locale!: string;
}

/** `GET /stores/my/consent-log` query. */
export class ListConsentLogQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Cursor: rows strictly older than this `created_at`. */
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @IsUUID()
  consent_id?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** `GET /stores/my/consent-log/summary` query. */
export class ConsentLogSummaryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

/** `GET /stores/my/consent-log/export` query (both required, max 366 days apart). */
export class ExportConsentLogQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;
}
