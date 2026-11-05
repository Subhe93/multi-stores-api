import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** Payout state of one order line, from the provider's point of view. */
export const PROVIDER_LINE_STATUSES = [
  // Paid (or delivered COD) order whose share has not been transferred yet.
  'pending',
  // Order not paid yet (awaiting card payment, COD not delivered).
  'unpaid',
  // A Stripe transfer to the provider succeeded.
  'transferred',
  // The last transfer attempt failed (will be retried by the platform).
  'failed',
  // Paid/delivered without a platform Stripe charge (COD, Kustom, direct
  // charge): settled outside platform payouts, never transferred.
  'offline',
  // The order was refunded or returned: the share is written off.
  'refunded',
  // The order was cancelled before it was fulfilled.
  'cancelled',
] as const;
export type ProviderLineStatus = (typeof PROVIDER_LINE_STATUSES)[number];

/**
 * YYYY-MM-DD (a UTC day) or a full ISO-8601 instant (clients send the bounds
 * of the viewer's local day as instants).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Date range + currency shared by the summary, the lines and the CSV. */
export class ProviderEarningsRangeDto {
  @IsOptional()
  @Matches(DATE_RE, {
    message: 'from must be a date (YYYY-MM-DD) or an ISO date-time',
  })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, {
    message: 'to must be a date (YYYY-MM-DD) or an ISO date-time',
  })
  to?: string;

  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter code' })
  currency?: string;
}

export class ProviderEarningsLinesQueryDto extends ProviderEarningsRangeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(PROVIDER_LINE_STATUSES)
  status?: ProviderLineStatus;
}

export class ProviderPayoutsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
