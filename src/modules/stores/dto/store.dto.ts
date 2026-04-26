import { IsString, IsOptional, IsBoolean, IsArray, IsObject } from 'class-validator';

export class CreateStoreDto {
  @IsString()
  slug: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  primary_locale?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secondary_locales?: string[];
}

export class UpdateStoreDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  logo_url?: string;

  @IsOptional()
  @IsString()
  favicon_url?: string;

  @IsOptional()
  @IsString()
  custom_domain?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateThemeDto {
  @IsObject()
  theme_config: Record<string, any>;
}

export class UpdateLanguageDto {
  @IsOptional()
  @IsString()
  primary_locale?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secondary_locales?: string[];

  @IsOptional()
  @IsBoolean()
  auto_translate?: boolean;
}
