import { IsString, IsOptional, IsInt, Min, Allow } from 'class-validator';
import { Type } from 'class-transformer';

export class AddCartItemDto {
  @IsOptional()
  @IsString()
  product_id?: string;

  @IsOptional()
  @IsString()
  variant_id?: string;

  @IsOptional()
  @IsString()
  custom_product_id?: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @Allow()
  custom_fields?: any;
}

export class UpdateCartItemDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity: number;
}
