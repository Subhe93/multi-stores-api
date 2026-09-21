import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

// One purchase line, the same shape POST /cart/items accepts (CartLine).
export class KustomCartLineDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bundle_offer_id?: string;

  @IsInt()
  @Min(1)
  @Max(999)
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @IsObject()
  custom_fields?: Record<string, unknown>;
}

// Session-first checkout: guests send their cart lines; a logged-in customer
// may omit `items` to check out the server cart. Nothing about money is taken
// from the client — every amount is priced on the server.
export class CreateKustomCheckoutSessionDto {
  @IsString()
  @MaxLength(50)
  store_slug: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => KustomCartLineDto)
  items?: KustomCartLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  coupon_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
}

// Resync an open session: omitted fields are unchanged, null clears the
// coupon / notes. The session token authenticates the caller.
export class UpdateKustomCheckoutSessionDto {
  @IsString()
  @MaxLength(128)
  token: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => KustomCartLineDto)
  items?: KustomCartLineDto[];

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  coupon_code?: string | null;

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
