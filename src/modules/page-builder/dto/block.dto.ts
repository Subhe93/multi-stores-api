import { IsString, IsOptional, IsEnum, IsInt, IsArray, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BlockType } from '@prisma/client';

export class BlockTranslationDto {
  @IsString()
  locale: string;

  content: any; // JSON — varies by block type
}

export class CreateBlockDto {
  @IsEnum(BlockType)
  type: BlockType;

  @IsOptional()
  settings?: any; // JSON — { layout, colors, spacing }

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockTranslationDto)
  translations?: BlockTranslationDto[];
}

export class UpdateBlockDto {
  @IsOptional()
  settings?: any;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockTranslationDto)
  translations?: BlockTranslationDto[];
}
