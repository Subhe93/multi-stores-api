import { ProvidersService } from './providers.service';
import { CreateProviderDto, UpdateProviderDto } from './dto/create-provider.dto';
export declare class ProvidersController {
    private providersService;
    constructor(providersService: ProvidersService);
    create(userId: string, dto: CreateProviderDto): Promise<{
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
    }>;
    getMyProfile(userId: string): Promise<{
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
    }>;
    updateMyProfile(userId: string, dto: UpdateProviderDto): Promise<{
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
    }>;
    findAll(page?: number, limit?: number): Promise<{
        data: ({
            user: {
                email: string;
                status: import("@prisma/client").$Enums.UserStatus;
            };
        } & {
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
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findById(id: string): Promise<{
        user: {
            email: string;
            status: import("@prisma/client").$Enums.UserStatus;
        };
    } & {
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
    }>;
    verify(id: string): Promise<{
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
    }>;
}
