import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from '@prisma/client';
import { CompanyDto, IsBuyerType } from '../../b2b/dto/b2b.dto';
import type { BuyerType } from '../../b2b/b2b.types';
import { TrackingContextDto } from '../../meta-capi/tracking-context';
import { QuoteLineDto } from './order.dto';

/** The delivery address a guest typed at checkout. */
export class GuestOrderAddressDto {
  @IsString()
  @MaxLength(200)
  full_name: string;

  @IsString()
  @MaxLength(300)
  line1: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  line2?: string;

  @IsString()
  @MaxLength(120)
  city: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsString()
  @MaxLength(20)
  postal_code: string;

  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country_code must be an ISO 3166-1 alpha-2 code',
  })
  country_code: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  // b2b app: company fields of this (billing) address.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  org_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyer_reference?: string;
}

/**
 * `POST /orders/guest`: a whole guest checkout in one public call. The
 * contact and store fields are those of the guest sign-up it replaces; the
 * order fields are CreateOrderDto's without `address_id` (the address is
 * typed here) and `item_customizations` (the lines carry their own fields).
 */
export class GuestOrderDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  // The store the checkout ran on (store_slug or hostname, else 400
  // STORE_REQUIRED); it must be the store of `store_id`.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  store_slug?: string;

  // Also the markets app host of the order (CreateOrderDto.hostname).
  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  // Cloudflare Turnstile token; required only while the API runs with
  // TURNSTILE_CUSTOMERS=on (400 AUTH_CAPTCHA_FAILED otherwise).
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstile_token?: string;

  @ValidateNested()
  @Type(() => GuestOrderAddressDto)
  address: GuestOrderAddressDto;

  // The purchase lines, in the shape POST /orders/quote takes.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines: QuoteLineDto[];

  @IsString()
  store_id: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

  @IsOptional()
  @IsString()
  coupon_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @IsOptional()
  @IsString()
  shipping_method_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  market_key?: string;

  @IsOptional()
  @IsBuyerType()
  buyer_type?: BuyerType;

  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyDto)
  company?: CompanyDto;

  @IsOptional()
  @IsBoolean()
  expect_reverse_charge?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => TrackingContextDto)
  tracking?: TrackingContextDto;
}
