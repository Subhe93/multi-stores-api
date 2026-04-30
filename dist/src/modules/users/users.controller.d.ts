import { UsersService } from './users.service';
import { UserRole, UserStatus } from '@prisma/client';
export declare class UsersController {
    private usersService;
    constructor(usersService: UsersService);
    findAll(page?: number, limit?: number, role?: UserRole, status?: UserStatus, search?: string): Promise<{
        data: {
            role: import("@prisma/client").$Enums.UserRole;
            status: import("@prisma/client").$Enums.UserStatus;
            id: string;
            email: string;
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
    getDashboardStats(): Promise<{
        totalUsers: number;
        totalProviders: number;
        totalCreators: number;
        totalCustomers: number;
        pendingProviders: number;
        pendingCreators: number;
    }>;
    getRecentUsers(): Promise<{
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        id: string;
        email: string;
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
    findById(id: string): Promise<{
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        id: string;
        email: string;
        avatar_url: string | null;
        created_at: Date;
        updated_at: Date;
        provider: {
            id: string;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            company_name: string;
            description: string | null;
            logo_url: string | null;
            phone: string | null;
            country: string;
            stripe_account_id: string | null;
            verified: boolean;
        } | null;
        creator: {
            id: string;
            avatar_url: string | null;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            phone: string | null;
            stripe_account_id: string | null;
            verified: boolean;
            display_name: string;
            bio: string | null;
            cover_url: string | null;
        } | null;
        customer: ({
            addresses: {
                id: string;
                created_at: Date;
                phone: string | null;
                customer_id: string;
                label: string | null;
                full_name: string;
                line1: string;
                line2: string | null;
                city: string;
                state: string | null;
                postal_code: string;
                country_code: string;
                is_default: boolean;
            }[];
        } & {
            id: string;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            phone: string | null;
            first_name: string;
            last_name: string;
        }) | null;
    }>;
    create(body: {
        email: string;
        password: string;
        role: UserRole;
        status?: UserStatus;
        avatar_url?: string;
        company_name?: string;
        description?: string;
        country?: string;
        phone?: string;
        verified?: boolean;
        display_name?: string;
        bio?: string;
        first_name?: string;
        last_name?: string;
    }): Promise<{
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        id: string;
        email: string;
        avatar_url: string | null;
        created_at: Date;
        updated_at: Date;
        provider: {
            id: string;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            company_name: string;
            description: string | null;
            logo_url: string | null;
            phone: string | null;
            country: string;
            stripe_account_id: string | null;
            verified: boolean;
        } | null;
        creator: {
            id: string;
            avatar_url: string | null;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            phone: string | null;
            stripe_account_id: string | null;
            verified: boolean;
            display_name: string;
            bio: string | null;
            cover_url: string | null;
        } | null;
        customer: ({
            addresses: {
                id: string;
                created_at: Date;
                phone: string | null;
                customer_id: string;
                label: string | null;
                full_name: string;
                line1: string;
                line2: string | null;
                city: string;
                state: string | null;
                postal_code: string;
                country_code: string;
                is_default: boolean;
            }[];
        } & {
            id: string;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            phone: string | null;
            first_name: string;
            last_name: string;
        }) | null;
    }>;
    update(id: string, body: {
        email?: string;
        status?: UserStatus;
        avatar_url?: string | null;
        company_name?: string;
        description?: string | null;
        country?: string;
        phone?: string | null;
        verified?: boolean;
        logo_url?: string | null;
        display_name?: string;
        bio?: string | null;
        cover_url?: string | null;
        first_name?: string;
        last_name?: string;
    }): Promise<{
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        id: string;
        email: string;
        avatar_url: string | null;
        created_at: Date;
        updated_at: Date;
        provider: {
            id: string;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            company_name: string;
            description: string | null;
            logo_url: string | null;
            phone: string | null;
            country: string;
            stripe_account_id: string | null;
            verified: boolean;
        } | null;
        creator: {
            id: string;
            avatar_url: string | null;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            phone: string | null;
            stripe_account_id: string | null;
            verified: boolean;
            display_name: string;
            bio: string | null;
            cover_url: string | null;
        } | null;
        customer: ({
            addresses: {
                id: string;
                created_at: Date;
                phone: string | null;
                customer_id: string;
                label: string | null;
                full_name: string;
                line1: string;
                line2: string | null;
                city: string;
                state: string | null;
                postal_code: string;
                country_code: string;
                is_default: boolean;
            }[];
        } & {
            id: string;
            created_at: Date;
            updated_at: Date;
            user_id: string;
            phone: string | null;
            first_name: string;
            last_name: string;
        }) | null;
    }>;
    updateStatus(id: string, status: UserStatus): Promise<{
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        id: string;
        email: string;
    }>;
    resetPassword(id: string, password: string): Promise<{
        message: string;
    }>;
    remove(id: string, actingUserId: string): Promise<{
        message: string;
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
    updatePlatformConfig(body: {
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
}
