import { Transform, Type } from 'class-transformer';
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /invoices/my and GET /invoices/admin. */
export class InvoiceQueryDto {
  @IsOptional() @IsIn(['INVOICE', 'CREDIT_NOTE']) kind?:
    | 'INVOICE'
    | 'CREDIT_NOTE';

  /** Issue date from (inclusive), YYYY-MM-DD. */
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  /** Issue date to (inclusive), YYYY-MM-DD. */
  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  /** Matches the document number, order number or buyer name. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  paid?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;

  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';

  /** Admin only: restrict to one store. */
  @IsOptional() @IsString() @MaxLength(64) store_id?: string;
}

/** GET /invoices/my/backlog. */
export class BacklogQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
