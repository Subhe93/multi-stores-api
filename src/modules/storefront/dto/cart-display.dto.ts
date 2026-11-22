import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Max lines per POST /storefront/:slug/cart-display (M160). */
export const CART_DISPLAY_MAX_LINES = 50;

/** One guest cart line: own product or custom product, optional variant. */
export class CartDisplayLineDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  product_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  custom_product_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  variant_id?: string;
}

/** POST /storefront/:slug/cart-display */
export class CartDisplayDto {
  /** Page locale (`de`, `de-AT`); omitted = store canonical language. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,4})?$/)
  locale?: string;

  @IsArray()
  @ArrayMaxSize(CART_DISPLAY_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => CartDisplayLineDto)
  lines: CartDisplayLineDto[];
}
