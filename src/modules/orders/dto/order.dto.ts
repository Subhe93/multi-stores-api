import { IsString, IsOptional, IsEnum, IsArray, ValidateNested } from 'class-validator';
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
  @IsOptional()
  @IsString()
  customer_design_url?: string;

  @IsOptional()
  @IsString()
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

  @IsOptional()
  @IsString()
  store_id?: string;

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

  // Custom field values per cart item (keyed by cart_item_id)
  @IsOptional()
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
