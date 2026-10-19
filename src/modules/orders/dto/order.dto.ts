import {
  ArrayMaxSize,
  IsBoolean,
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsInt,
  IsObject,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus, FulfillmentStatus, PaymentMethod } from '@prisma/client';
import { CompanyDto, IsBuyerType } from '../../b2b/dto/b2b.dto';
import type { BuyerType } from '../../b2b/b2b.types';

export class OrderCustomFieldValueDto {
  @IsString()
  custom_field_id: string;

  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  @IsString()
  file_url?: string;
}

export class OrderItemCustomizationDto {
  // Stored on the order item and rendered back in the dashboard, so restrict it
  // to an http(s) or uploads-relative location — `javascript:` and `data:` URLs
  // would otherwise reach an href/src attribute verbatim.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Matches(/^(https?:\/\/|\/uploads\/)/, {
    message: 'customer_design_url must be an http(s) or /uploads/ URL',
  })
  customer_design_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  design_notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderCustomFieldValueDto)
  custom_field_values?: OrderCustomFieldValueDto[];
}

export class CreateOrderDto {
  @IsString()
  address_id: string;

  // Required: the store the order is placed through. The server validates that
  // every cart line actually belongs to this store before pricing the order —
  // without it the commission model, COD gate and Stripe routing would all be
  // driven by an unverified client value.
  @IsString()
  store_id: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  coupon_code?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

  @IsOptional()
  @IsString()
  stripe_payment_intent_id?: string;

  // The shipping method chosen from the quote for the address country. Must
  // be one of the ids the quote offers (ORDER_SHIPPING_METHOD_INVALID
  // otherwise); omitted, the first offered method is used.
  @IsOptional()
  @IsString()
  shipping_method_id?: string;

  // Custom field values per cart item (keyed by cart_item_id). Validated per
  // value — without it the whole map bypassed the global ValidationPipe, so
  // arbitrary shapes (and arbitrary strings) were stored on the order item.
  @IsOptional()
  @IsObject()
  @ValidateNested({ each: true })
  @Type(() => OrderItemCustomizationDto)
  item_customizations?: Record<string, OrderItemCustomizationDto>;

  // Markets app (ignored while the app is off): the market the storefront
  // resolved for the host, the host itself (accepted only when it is one of
  // the market's own hostnames) and the UI locale, snapshotted on the order.
  @IsOptional()
  @IsString()
  @MaxLength(16)
  market_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(253)
  hostname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  // b2b app (ignored while the app is off): the buyer type the storefront
  // ran in and, for a company purchase, the company snapshot of the order.
  // A COMPANY request on a store that does not accept it is refused
  // (B2B_COMPANY_NOT_ALLOWED) rather than silently placed as a person.
  @IsOptional()
  @IsBuyerType()
  buyer_type?: BuyerType;

  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyDto)
  company?: CompanyDto;

  // b2b app M2.5: the quote the buyer saw was VAT-free (reverse charge).
  // When the server cannot confirm it, the order is refused with 409
  // B2B_REVERSE_CHARGE_NOT_CONFIRMED instead of silently charging VAT.
  @IsOptional()
  @IsBoolean()
  expect_reverse_charge?: boolean;
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @IsOptional()
  @IsString()
  note?: string;

  // Production app ship prompt (M5.4): with SHIPPED, written to the actor's
  // items (the shipped email reads the first item tracking number).
  @IsOptional()
  @IsString()
  @MaxLength(120)
  tracking_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  tracking_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  carrier?: string;
}

export class UpdateFulfillmentDto {
  @IsEnum(FulfillmentStatus)
  fulfillment_status: FulfillmentStatus;

  @IsOptional()
  @IsString()
  tracking_number?: string;

  @IsOptional()
  @IsString()
  tracking_url?: string;
}

// One purchase line for `POST /orders/quote` — the shape `POST /cart/items`
// accepts (CartLine), validated per entry.
export class QuoteLineDto {
  @IsOptional()
  @IsString()
  product_id?: string | null;

  @IsOptional()
  @IsString()
  custom_product_id?: string | null;

  @IsOptional()
  @IsString()
  variant_id?: string | null;

  @IsOptional()
  @IsString()
  bundle_offer_id?: string | null;

  // Same ceiling as KustomCartLineDto: a quote is public, so it must not be
  // able to price absurd quantities.
  @IsInt()
  @Min(1)
  @Max(999)
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @IsObject()
  custom_fields?: Record<string, unknown> | null;

  // Designer app (M4.2): the line's customer design (a guest line also
  // sends its design token, checked when given).
  @IsOptional()
  @IsUUID()
  design_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  design_token?: string | null;
}

// `POST /orders/quote`: price lines (or the caller's server cart when
// omitted and logged in) for a destination, without creating anything.
export class QuoteOrderDto {
  @IsString()
  store_id: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines?: QuoteLineDto[];

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country_code must be an ISO 3166-1 alpha-2 code',
  })
  country_code?: string;

  // Free-text address state as stored on Address.state (e.g. "Stockholms län"),
  // not a rate region code — the engine normalises it before matching.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postcode?: string;

  @IsOptional()
  @IsString()
  shipping_method_id?: string;

  @IsOptional()
  @IsString()
  coupon_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  // Markets app: price the quote in this market (ignored while the app is off).
  @IsOptional()
  @IsString()
  @MaxLength(16)
  market_key?: string;

  // Market-preview host: quote a DRAFT market too (display only; an order
  // can never be created in a market that is not LIVE).
  @IsOptional()
  @IsBoolean()
  preview?: boolean;

  // b2b app: quote for the company view (ignored while the app is off).
  @IsOptional()
  @IsBuyerType()
  buyer_type?: BuyerType;

  // b2b app M2.5: the company's VAT number (a guest quote has no `company`
  // object). Read only for a COMPANY buyer while reverse charge is on.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  vat_number?: string;
}
