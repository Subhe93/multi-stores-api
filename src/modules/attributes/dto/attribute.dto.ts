import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsEnum,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AttributeType } from '@prisma/client';

export class CreateAttributeTemplateDto {
  @IsString()
  name: string;

  @IsEnum(AttributeType)
  type: AttributeType;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  options?: any; // Json

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsString()
  group_name?: string;

  @IsOptional()
  validation_rules?: any; // Json

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeTranslationDto)
  translations?: AttributeTranslationDto[];
}

export class AttributeTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  label: string;

  @IsOptional()
  option_labels?: any; // Json
}

export class UpdateAttributeTemplateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(AttributeType)
  type?: AttributeType;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  options?: any;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsString()
  group_name?: string;

  @IsOptional()
  validation_rules?: any;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeTranslationDto)
  translations?: AttributeTranslationDto[];
}
