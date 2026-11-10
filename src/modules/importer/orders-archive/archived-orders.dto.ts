import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** `?storeId=` of the admin variant of the archived-orders routes. */
export class ArchivedOrdersStoreQueryDto {
  @IsOptional()
  @IsUUID()
  storeId?: string;
}

/** Filters of GET /archived-orders and /archived-orders/export.csv. */
export class ArchivedOrdersListQueryDto extends ArchivedOrdersStoreQueryDto {
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

  /** Matches number / customer name / customer email (case-insensitive). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** WooCommerce status without the `wc-` prefix. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z0-9-]+$/i)
  status?: string;

  /**
   * `YYYY-MM-DD`, inclusive, read as UTC calendar days: `from` = 00:00:00Z
   * of that day, `to` = 23:59:59.999Z (the archive stores WooCommerce's
   * GMT creation time).
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

/** `?dryRun=1&storeId=` of POST /importer/orders-archive. */
export class OrdersArchiveImportQueryDto extends ArchivedOrdersStoreQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(5)
  dryRun?: string;
}
