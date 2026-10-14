import { IsString, IsOptional, Length, MaxLength } from 'class-validator';
import { IsBuyerType } from '../../b2b/dto/b2b.dto';
import type { BuyerType } from '../../b2b/b2b.types';

export class CreateCustomerDto {
  @IsString()
  @Length(2, 50)
  first_name: string;

  @IsString()
  @Length(2, 50)
  last_name: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @Length(2, 50)
  first_name?: string;

  @IsOptional()
  @IsString()
  @Length(2, 50)
  last_name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  // b2b app: the customer's default buyer type and company identity, used
  // to prefill checkout. Stored as typed (normalised, not validated): the
  // order path validates the snapshot. `null` clears a field; an absent key
  // leaves it alone. Inert for stores without the app.
  @IsOptional()
  @IsBuyerType()
  customer_type?: BuyerType | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company_name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  org_number?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  vat_number?: string | null;
}

export class CreateAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsString()
  full_name: string;

  @IsString()
  line1: string;

  @IsOptional()
  @IsString()
  line2?: string;

  @IsString()
  city: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsString()
  postal_code: string;

  @IsString()
  @Length(2, 2)
  country_code: string;

  @IsOptional()
  @IsString()
  phone?: string;

  // b2b app: company fields of this (billing) address, prefill only.
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
  @MaxLength(100)
  buyer_reference?: string;
}
