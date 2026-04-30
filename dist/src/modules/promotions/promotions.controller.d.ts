import { PromotionsService } from './promotions.service';
import { CreatePromotionDto, UpdatePromotionDto, ValidateCouponDto } from './dto/promotion.dto';
import { UserRole } from '@prisma/client';
export declare class PromotionsController {
    private promotionsService;
    constructor(promotionsService: PromotionsService);
    create(userId: string, role: UserRole, dto: CreatePromotionDto): Promise<{
        translations: {
            id: string;
            description: string | null;
            locale: string;
            title: string;
            promotion_id: string;
        }[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.PromotionStatus;
        created_at: Date;
        updated_at: Date;
        creator_id: string | null;
        type: import("@prisma/client").$Enums.PromotionType;
        expires_at: Date | null;
        provider_id: string | null;
        value: import("@prisma/client/runtime/library").Decimal;
        coupon_code: string | null;
        level: import("@prisma/client").$Enums.PromotionLevel;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        usage_limit: number | null;
        starts_at: Date;
        usage_count: number;
    }>;
    findMyPromotions(userId: string, role: UserRole, page?: number, limit?: number): Promise<{
        data: ({
            translations: {
                id: string;
                description: string | null;
                locale: string;
                title: string;
                promotion_id: string;
            }[];
        } & {
            id: string;
            status: import("@prisma/client").$Enums.PromotionStatus;
            created_at: Date;
            updated_at: Date;
            creator_id: string | null;
            type: import("@prisma/client").$Enums.PromotionType;
            expires_at: Date | null;
            provider_id: string | null;
            value: import("@prisma/client/runtime/library").Decimal;
            coupon_code: string | null;
            level: import("@prisma/client").$Enums.PromotionLevel;
            conditions: import("@prisma/client/runtime/library").JsonValue;
            usage_limit: number | null;
            starts_at: Date;
            usage_count: number;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findById(id: string): Promise<{
        translations: {
            id: string;
            description: string | null;
            locale: string;
            title: string;
            promotion_id: string;
        }[];
        usages: {
            id: string;
            created_at: Date;
            user_id: string;
            promotion_id: string;
            discount_amount: import("@prisma/client/runtime/library").Decimal;
            order_id: string;
        }[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.PromotionStatus;
        created_at: Date;
        updated_at: Date;
        creator_id: string | null;
        type: import("@prisma/client").$Enums.PromotionType;
        expires_at: Date | null;
        provider_id: string | null;
        value: import("@prisma/client/runtime/library").Decimal;
        coupon_code: string | null;
        level: import("@prisma/client").$Enums.PromotionLevel;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        usage_limit: number | null;
        starts_at: Date;
        usage_count: number;
    }>;
    update(id: string, dto: UpdatePromotionDto, userId: string, role: UserRole): Promise<{
        translations: {
            id: string;
            description: string | null;
            locale: string;
            title: string;
            promotion_id: string;
        }[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.PromotionStatus;
        created_at: Date;
        updated_at: Date;
        creator_id: string | null;
        type: import("@prisma/client").$Enums.PromotionType;
        expires_at: Date | null;
        provider_id: string | null;
        value: import("@prisma/client/runtime/library").Decimal;
        coupon_code: string | null;
        level: import("@prisma/client").$Enums.PromotionLevel;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        usage_limit: number | null;
        starts_at: Date;
        usage_count: number;
    }>;
    delete(id: string, userId: string, role: UserRole): Promise<{
        id: string;
        status: import("@prisma/client").$Enums.PromotionStatus;
        created_at: Date;
        updated_at: Date;
        creator_id: string | null;
        type: import("@prisma/client").$Enums.PromotionType;
        expires_at: Date | null;
        provider_id: string | null;
        value: import("@prisma/client/runtime/library").Decimal;
        coupon_code: string | null;
        level: import("@prisma/client").$Enums.PromotionLevel;
        conditions: import("@prisma/client/runtime/library").JsonValue;
        usage_limit: number | null;
        starts_at: Date;
        usage_count: number;
    }>;
    validateCoupon(dto: ValidateCouponDto): Promise<{
        valid: boolean;
        promotion_id: string;
        type: import("@prisma/client").$Enums.PromotionType;
        value: number;
        discount_amount: number;
        free_shipping: boolean;
    }>;
}
