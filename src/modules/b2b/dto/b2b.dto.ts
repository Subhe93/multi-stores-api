import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidationOptions,
} from 'class-validator';
import { BUYER_TYPES } from '../b2b.types';

/**
 * The `company` object of a company checkout (order body, Kustom session).
 * Format validation (org / VAT number by country) happens in
 * B2bService.validateCompany, not here - this only bounds the strings.
 * Missing / blank company_name and org_number are deliberately allowed
 * through so the service answers with B2B_COMPANY_NAME_REQUIRED /
 * B2B_ORG_NUMBER_REQUIRED instead of raw class-validator messages.
 */
export class CompanyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  org_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  vat_number?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyer_reference?: string | null;
}

/**
 * Validator for a buyer-type body field (`buyer_type`, `customer_type`):
 * `@IsOptional() @IsBuyerType()`. The message names the validated property.
 */
export function IsBuyerType(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return IsIn(BUYER_TYPES as readonly string[], {
    message: `$property must be one of ${BUYER_TYPES.join(', ')}`,
    ...validationOptions,
  });
}
