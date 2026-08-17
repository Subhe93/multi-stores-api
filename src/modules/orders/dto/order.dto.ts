import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsObject,
  Matches,
  MaxLength,
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
