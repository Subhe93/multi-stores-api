import { IsString, IsOptional, Length } from 'class-validator';
import { UploadUrl } from '../../../common/uploads/upload-url.transform';

export class CreateCreatorDto {
  @IsString()
  @Length(2, 50)
  display_name: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class UpdateCreatorDto {
  @IsOptional()
  @IsString()
  @Length(2, 50)
  display_name?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @UploadUrl()
  avatar_url?: string;
}
