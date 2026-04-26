import { CommissionsService } from './commissions.service';
import { UserRole } from '@prisma/client';
export declare class CommissionsController {
    private commissionsService;
    constructor(commissionsService: CommissionsService);
    getSummary(userId: string, role: UserRole): Promise<{
        total_earnings: number;
        this_month: number;
        pending: number;
        total_orders?: undefined;
    } | {
        total_earnings: number;
        this_month: number;
        pending: number;
        total_orders: number;
    }>;
    getPlatformSummary(): Promise<{
        platform_earnings: number;
        platform_this_month: number;
        total_revenue: number;
        total_orders: number;
    }>;
    getByOrder(orderId: string): Promise<{
        id: string;
        status: import("@prisma/client").$Enums.CommissionStatus;
        created_at: Date;
        order_id: string;
        currency: string;
        provider_amount: import("@prisma/client/runtime/library").Decimal;
        platform_amount: import("@prisma/client/runtime/library").Decimal;
        creator_amount: import("@prisma/client/runtime/library").Decimal;
    } | null>;
}
