import { IsString, IsOptional, IsBoolean, IsNumber, IsInt, IsObject, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateVariantDto {
  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  price_adjustment?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  compare_at_price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  stock_quantity?: number;

  @IsObject()
  options: Record<string, string>; // { "size": "L", "color": "black" }
}

export class UpdateVariantDto {
  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  price_adjustment?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  compare_at_price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  stock_quantity?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsObject()
  options?: Record<string, string>;
}
