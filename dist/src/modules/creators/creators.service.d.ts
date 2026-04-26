import { PrismaService } from '../../prisma/prisma.service';
import { CreateCreatorDto, UpdateCreatorDto } from './dto/create-creator.dto';
export declare class CreatorsService {
    private prisma;
    constructor(prisma: PrismaService);
    create(userId: string, dto: CreateCreatorDto): Promise<{
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
    }>;
    findByUserId(userId: string): Promise<{
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
    }>;
    findById(id: string): Promise<{
        user: {
            email: string;
            status: import("@prisma/client").$Enums.UserStatus;
        };
    } & {
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
    }>;
    update(userId: string, dto: UpdateCreatorDto): Promise<{
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
    }>;
    findAll(page?: number, limit?: number): Promise<{
        data: ({
            user: {
                email: string;
                status: import("@prisma/client").$Enums.UserStatus;
            };
        } & {
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
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    verify(id: string): Promise<{
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
    }>;
}
