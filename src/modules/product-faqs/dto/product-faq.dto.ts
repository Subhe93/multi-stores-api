import { IsString, IsOptional, IsArray, ValidateNested, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class FaqTranslationDto {
  @IsString()
  locale: string;

  @IsString()
  question: string;

  @IsString()
  answer: string;
}

export class CreateProductFaqDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaqTranslationDto)
  translations: FaqTranslationDto[];
}

export class UpdateProductFaqDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaqTranslationDto)
  translations?: FaqTranslationDto[];
}
