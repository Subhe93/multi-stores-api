import { IsString, IsOptional, Length } from 'class-validator';

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
}
