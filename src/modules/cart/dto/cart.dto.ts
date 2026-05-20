import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Allow,
  ValidateIf,
} from 'class-validator';
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

  @IsOptional()
  @IsString()
  bundle_offer_id?: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @Allow()
  custom_fields?: any;
}

export class UpdateCartItemDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity?: number;

  // Pass `null` to clear the bundle on this line.
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  bundle_offer_id?: string | null;
}
