import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// Bodies of the reverse-charge routes (b2b app, M2.5). VAT numbers are only
// bounded here; format and VIES validity are decided by the services, which
// answer with a status (never a validation error) for the checks.

/** POST /storefront/:slug/b2b/vat-check */
export class VatCheckDto {
  @IsString()
  @MaxLength(32)
  vat_number: string;

  /** Shipping destination (ISO2); omitted = no reverse-charge verdict. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country_code must be an ISO 3166-1 alpha-2 code',
  })
  country_code?: string;
}

/** POST /b2b/my/tax-exemptions/vat-check */
export class DashboardVatCheckDto {
  @IsString()
  @MaxLength(32)
  vat_number: string;
}

/** POST /b2b/my/tax-exemptions */
export class CreateTaxExemptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customer_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  order_id?: string;

  @IsIn(['REVERSE_CHARGE', 'FULL'], {
    message: 'kind must be one of REVERSE_CHARGE, FULL',
  })
  kind: 'REVERSE_CHARGE' | 'FULL';

  @IsOptional()
  @IsString()
  @MaxLength(32)
  vat_number?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** GET /b2b/my/tax-exemptions?include_revoked=true */
export class ListTaxExemptionsQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  include_revoked?: boolean;
}
