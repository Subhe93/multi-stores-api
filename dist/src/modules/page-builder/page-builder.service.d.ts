import { PrismaService } from '../../prisma/prisma.service';
import { CreateBlockDto, UpdateBlockDto } from './dto/block.dto';
export declare class PageBuilderService {
    private prisma;
    constructor(prisma: PrismaService);
    getBlocks(pageId: string): Promise<({
        translations: {
            id: string;
            locale: string;
            content: import("@prisma/client/runtime/library").JsonValue;
            block_id: string;
        }[];
    } & {
        id: string;
        created_at: Date;
        type: import("@prisma/client").$Enums.BlockType;
        sort_order: number;
        page_id: string;
        settings: import("@prisma/client/runtime/library").JsonValue;
    })[]>;
    addBlock(pageId: string, dto: CreateBlockDto): Promise<{
        translations: {
            id: string;
            locale: string;
            content: import("@prisma/client/runtime/library").JsonValue;
            block_id: string;
        }[];
    } & {
        id: string;
        created_at: Date;
        type: import("@prisma/client").$Enums.BlockType;
        sort_order: number;
        page_id: string;
        settings: import("@prisma/client/runtime/library").JsonValue;
    }>;
    updateBlock(id: string, dto: UpdateBlockDto): Promise<{
        translations: {
            id: string;
            locale: string;
            content: import("@prisma/client/runtime/library").JsonValue;
            block_id: string;
        }[];
    } & {
        id: string;
        created_at: Date;
        type: import("@prisma/client").$Enums.BlockType;
        sort_order: number;
        page_id: string;
        settings: import("@prisma/client/runtime/library").JsonValue;
    }>;
    deleteBlock(id: string): Promise<{
        id: string;
        created_at: Date;
        type: import("@prisma/client").$Enums.BlockType;
        sort_order: number;
        page_id: string;
        settings: import("@prisma/client/runtime/library").JsonValue;
    }>;
    reorderBlocks(pageId: string, blockIds: string[]): Promise<({
        translations: {
            id: string;
            locale: string;
            content: import("@prisma/client/runtime/library").JsonValue;
            block_id: string;
        }[];
    } & {
        id: string;
        created_at: Date;
        type: import("@prisma/client").$Enums.BlockType;
        sort_order: number;
        page_id: string;
        settings: import("@prisma/client/runtime/library").JsonValue;
    })[]>;
}
