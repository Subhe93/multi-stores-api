import { IsString, IsOptional, Length } from 'class-validator';

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
  avatar_url?: string;
}
