import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CompanyDto, IsBuyerType } from '../../../b2b/dto/b2b.dto';
import type { BuyerType } from '../../../b2b/b2b.types';

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

  // Designer app (M4.2 WP4): the line's customer design. Kept in the
  // session snapshot (normalizeCartLine); the token is checked when the
  // session is priced and never stored.
  @IsOptional()
  @IsUUID()
  design_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  design_token?: string;
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

  // Markets app: the market the storefront resolved for the host and the
  // host itself. Accepted here so the global whitelist does not reject the
  // body; wired into the session by WP-B.
  @IsOptional()
  @IsString()
  @MaxLength(16)
  market_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;

  // b2b app (ignored while the app is off): the buyer type the storefront
  // runs in and, for a company checkout, the company prefill. Kustom
  // collects and validates the organisation in its iframe; this is a hint.
  @IsOptional()
  @IsBuyerType()
  buyer_type?: BuyerType;

  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyDto)
  company?: CompanyDto;
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

  // b2b app: the storefront re-sends both whenever the app is on (a toggle
  // mid-checkout re-prices the session); null = person / no company.
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsBuyerType()
  buyer_type?: BuyerType | null;

  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyDto)
  company?: CompanyDto | null;
}
