import { CommissionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
export declare class CommissionsService {
    private prisma;
    constructor(prisma: PrismaService);
    getByOrder(orderId: string): Promise<{
        id: string;
        status: import("@prisma/client").$Enums.CommissionStatus;
        created_at: Date;
        order_id: string;
        currency: string;
        provider_amount: Prisma.Decimal;
        platform_amount: Prisma.Decimal;
        creator_amount: Prisma.Decimal;
    } | null>;
    getSummary(userId: string, role: 'provider' | 'creator'): Promise<{
        total_earnings: number;
        this_month: number;
        pending: number;
        total_orders: number;
    }>;
    getPlatformSummary(): Promise<{
        platform_earnings: number;
        platform_this_month: number;
        provider_earnings: number;
        provider_this_month: number;
        creator_earnings: number;
        creator_this_month: number;
        total_revenue: number;
        total_this_month: number;
        pending_platform: number;
        paid_platform: number;
        total_orders: number;
    }>;
    getAdminList(params: {
        page?: number;
        limit?: number;
        status?: CommissionStatus;
        search?: string;
    }): Promise<{
        data: {
            id: string;
            order_id: string;
            order_number: string;
            order_status: import("@prisma/client").$Enums.OrderStatus;
            order_total: number;
            order_subtotal: number;
            order_discount: number;
            platform_amount: number;
            provider_amount: number;
            creator_amount: number;
            currency: string;
            status: import("@prisma/client").$Enums.CommissionStatus;
            created_at: Date;
            customer: {
                id: string;
                name: string;
                email: string;
            } | null;
            store: {
                id: string;
                name: string;
                slug: string;
            } | null;
            creator: {
                id: string;
                name: string;
            } | null;
            providers: string[];
        }[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
}
