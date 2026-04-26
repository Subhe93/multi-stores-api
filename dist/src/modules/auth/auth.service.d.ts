import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto, LoginDto } from './dto';
export declare class AuthService {
    private prisma;
    private jwtService;
    private configService;
    constructor(prisma: PrismaService, jwtService: JwtService, configService: ConfigService);
    register(dto: RegisterDto): Promise<{
        access_token: string;
        refresh_token: string;
        user: {
            id: string;
            email: string;
            role: import("@prisma/client").$Enums.UserRole;
            status: import("@prisma/client").$Enums.UserStatus;
            created_at: Date;
        };
    }>;
    login(dto: LoginDto): Promise<{
        access_token: string;
        refresh_token: string;
        user: {
            id: string;
            email: string;
            role: import("@prisma/client").$Enums.UserRole;
            status: "ACTIVE";
        };
    }>;
    refreshToken(refreshToken: string): Promise<{
        access_token: string;
        refresh_token: string;
    }>;
    logout(userId: string, refreshToken: string): Promise<{
        message: string;
    }>;
    forgotPassword(email: string): Promise<{
        message: string;
    }>;
    resetPassword(token: string, newPassword: string): Promise<{
        message: string;
    }>;
    changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{
        message: string;
    }>;
    getProfile(userId: string): Promise<{
        id: string;
        email: string;
        role: import("@prisma/client").$Enums.UserRole;
        status: import("@prisma/client").$Enums.UserStatus;
        avatar_url: string | null;
        created_at: Date;
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
        customer: {
            id: string;
            created_at: Date;
            updated_at: Date;
            phone: string | null;
            user_id: string;
            first_name: string;
            last_name: string;
        } | null;
    }>;
    private generateTokens;
}
