import { IsString, IsOptional, Length } from 'class-validator';

export class CreateProviderDto {
  @IsString()
  @Length(2, 100)
  company_name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @Length(2, 2)
  country: string;
}

export class UpdateProviderDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  company_name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  @IsOptional()
  @IsString()
  logo_url?: string;
}
