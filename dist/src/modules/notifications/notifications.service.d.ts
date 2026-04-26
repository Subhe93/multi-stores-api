import { PrismaService } from '../../prisma/prisma.service';
export declare class NotificationsService {
    private prisma;
    constructor(prisma: PrismaService);
    findByUser(userId: string, page?: number, limit?: number): Promise<{
        data: {
            id: string;
            created_at: Date;
            user_id: string;
            type: string;
            data: import("@prisma/client/runtime/library").JsonValue | null;
            title: string;
            body: string;
            is_read: boolean;
        }[];
        unread_count: number;
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    markAsRead(id: string): Promise<{
        id: string;
        created_at: Date;
        user_id: string;
        type: string;
        data: import("@prisma/client/runtime/library").JsonValue | null;
        title: string;
        body: string;
        is_read: boolean;
    }>;
    markAllAsRead(userId: string): Promise<{
        message: string;
    }>;
    create(userId: string, type: string, title: string, body: string, data?: any): Promise<{
        id: string;
        created_at: Date;
        user_id: string;
        type: string;
        data: import("@prisma/client/runtime/library").JsonValue | null;
        title: string;
        body: string;
        is_read: boolean;
    }>;
}
