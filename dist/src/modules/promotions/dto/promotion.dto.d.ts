import { PromotionType, PromotionLevel, PromotionStatus } from '@prisma/client';
export declare class PromotionTranslationDto {
    locale: string;
    title: string;
    description?: string;
}
export declare class CreatePromotionDto {
    type: PromotionType;
    level: PromotionLevel;
    value: number;
    conditions?: any;
    coupon_code?: string;
    usage_limit?: number;
    starts_at: string;
    expires_at?: string;
    translations?: PromotionTranslationDto[];
}
export declare class UpdatePromotionDto {
    value?: number;
    conditions?: any;
    usage_limit?: number;
    expires_at?: string;
    status?: PromotionStatus;
    translations?: PromotionTranslationDto[];
}
export declare class ValidateCouponDto {
    coupon_code: string;
    subtotal?: number;
    item_count?: number;
    product_ids?: string[];
}
