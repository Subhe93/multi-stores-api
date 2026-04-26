import { OrderStatus, FulfillmentStatus, PaymentMethod } from '@prisma/client';
export declare class OrderCustomFieldValueDto {
    custom_field_id: string;
    value?: string;
    file_url?: string;
}
export declare class OrderItemCustomizationDto {
    customer_design_url?: string;
    design_notes?: string;
    custom_field_values?: OrderCustomFieldValueDto[];
}
export declare class CreateOrderDto {
    address_id: string;
    store_id?: string;
    notes?: string;
    coupon_code?: string;
    payment_method?: PaymentMethod;
    stripe_payment_intent_id?: string;
    item_customizations?: Record<string, OrderItemCustomizationDto>;
}
export declare class UpdateOrderStatusDto {
    status: OrderStatus;
    note?: string;
}
export declare class UpdateFulfillmentDto {
    fulfillment_status: FulfillmentStatus;
    tracking_number?: string;
    tracking_url?: string;
}
