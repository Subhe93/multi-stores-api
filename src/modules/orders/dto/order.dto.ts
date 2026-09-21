import {
  ArrayMaxSize,
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsInt,
  IsObject,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus, FulfillmentStatus, PaymentMethod } from '@prisma/client';

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
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @IsOptional()
  @IsString()
  note?: string;
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
}
