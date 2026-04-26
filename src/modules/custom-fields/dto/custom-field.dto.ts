import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsInt,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CustomFieldType } from '@prisma/client';

export class CustomFieldTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  placeholder?: string;

  @IsOptional()
  option_labels?: any;
}

export class CreateCustomFieldDto {
  @IsString()
  name: string;

  @IsEnum(CustomFieldType)
  type: CustomFieldType;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsString()
  placeholder?: string;

  @IsOptional()
  options?: any; // JSON for select options

  @IsOptional()
  validation_rules?: any; // { max_length, pattern, allowed_chars }

  @IsOptional()
  linked_validation?: any; // { type, target_field_id, fill_char }

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldTranslationDto)
  translations?: CustomFieldTranslationDto[];
}

export class UpdateCustomFieldDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(CustomFieldType)
  type?: CustomFieldType;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsString()
  placeholder?: string;

  @IsOptional()
  options?: any;

  @IsOptional()
  validation_rules?: any;

  @IsOptional()
  linked_validation?: any;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldTranslationDto)
  translations?: CustomFieldTranslationDto[];
}
