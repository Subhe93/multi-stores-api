import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus } from '@prisma/client';
export declare class UsersService {
    private prisma;
    constructor(prisma: PrismaService);
    findAll(page?: number, limit?: number, filters?: {
        role?: UserRole;
        status?: UserStatus;
        search?: string;
    }): Promise<{
        data: {
            id: string;
            email: string;
            role: import("@prisma/client").$Enums.UserRole;
            status: import("@prisma/client").$Enums.UserStatus;
            avatar_url: string | null;
            created_at: Date;
            provider: {
                company_name: string;
                verified: boolean;
            } | null;
            creator: {
                verified: boolean;
                display_name: string;
            } | null;
            customer: {
                first_name: string;
                last_name: string;
            } | null;
        }[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findById(id: string): Promise<{
        id: string;
        email: string;
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        avatar_url: string | null;
        created_at: Date;
        updated_at: Date;
        provider: {
            id: string;
            created_at: Date;
            updated_at: Date;
            company_name: string;
            description: string | null;
            logo_url: string | null;
            phone: string | null;
            country: string;
            stripe_account_id: string | null;
            verified: boolean;
            user_id: string;
        } | null;
        creator: {
            id: string;
            avatar_url: string | null;
            created_at: Date;
            updated_at: Date;
            phone: string | null;
            stripe_account_id: string | null;
            verified: boolean;
            display_name: string;
            bio: string | null;
            cover_url: string | null;
            user_id: string;
        } | null;
        customer: ({
            addresses: {
                id: string;
                created_at: Date;
                phone: string | null;
                label: string | null;
                full_name: string;
                line1: string;
                line2: string | null;
                city: string;
                state: string | null;
                postal_code: string;
                country_code: string;
                is_default: boolean;
                customer_id: string;
            }[];
        } & {
            id: string;
            created_at: Date;
            updated_at: Date;
            phone: string | null;
            user_id: string;
            first_name: string;
            last_name: string;
        }) | null;
    }>;
    updateStatus(id: string, status: UserStatus): Promise<{
        id: string;
        email: string;
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
    }>;
    getDashboardStats(): Promise<{
        totalUsers: number;
        totalProviders: number;
        totalCreators: number;
        totalCustomers: number;
        pendingProviders: number;
        pendingCreators: number;
    }>;
    getPlatformConfig(): Promise<{
        id: string;
        updated_at: Date;
        commission_type: string;
        commission_value: import("@prisma/client/runtime/library").Decimal;
        default_currency: string;
        default_locale: string;
        supported_locales: string[];
        platform_name: string;
        support_email: string | null;
        min_order_amount: import("@prisma/client/runtime/library").Decimal | null;
        require_provider_approval: boolean;
        require_creator_approval: boolean;
    }>;
    updatePlatformConfig(data: {
        commission_type?: string;
        commission_value?: number;
        default_currency?: string;
        default_locale?: string;
        supported_locales?: string[];
        platform_name?: string;
        support_email?: string;
        min_order_amount?: number | null;
        require_provider_approval?: boolean;
        require_creator_approval?: boolean;
    }): Promise<{
        id: string;
        updated_at: Date;
        commission_type: string;
        commission_value: import("@prisma/client/runtime/library").Decimal;
        default_currency: string;
        default_locale: string;
        supported_locales: string[];
        platform_name: string;
        support_email: string | null;
        min_order_amount: import("@prisma/client/runtime/library").Decimal | null;
        require_provider_approval: boolean;
        require_creator_approval: boolean;
    }>;
    getRecentUsers(limit?: number): Promise<{
        id: string;
        email: string;
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        created_at: Date;
        provider: {
            company_name: string;
        } | null;
        creator: {
            display_name: string;
        } | null;
        customer: {
            first_name: string;
            last_name: string;
        } | null;
    }[]>;
}
