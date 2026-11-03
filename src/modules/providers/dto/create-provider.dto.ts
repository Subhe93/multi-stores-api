import { IsString, IsOptional, Length } from 'class-validator';
import { UploadUrl } from '../../../common/uploads/upload-url.transform';

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
  @UploadUrl()
  logo_url?: string;
}
