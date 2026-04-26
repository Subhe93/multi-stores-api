import { UserRole } from '@prisma/client';
export declare class RegisterDto {
    email: string;
    password: string;
    role: UserRole;
    first_name?: string;
    last_name?: string;
    phone?: string;
}
