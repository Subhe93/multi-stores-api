import { PagesService } from './pages.service';
import { CreatePageDto, UpdatePageDto } from './dto/page.dto';
export declare class PagesController {
    private pagesService;
    constructor(pagesService: PagesService);
    findByStore(storeId: string): Promise<({
        translations: {
            id: string;
            locale: string;
            title: string;
            page_id: string;
            content: string | null;
        }[];
        blocks: ({
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
        })[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.PageStatus;
        created_at: Date;
        updated_at: Date;
        slug: string;
        type: import("@prisma/client").$Enums.StaticPageType;
        is_required: boolean;
        sort_order: number;
        store_id: string;
    })[]>;
    create(storeId: string, dto: CreatePageDto): Promise<{
        translations: {
            id: string;
            locale: string;
            title: string;
            page_id: string;
            content: string | null;
        }[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.PageStatus;
        created_at: Date;
        updated_at: Date;
        slug: string;
        type: import("@prisma/client").$Enums.StaticPageType;
        is_required: boolean;
        sort_order: number;
        store_id: string;
    }>;
    findById(id: string): Promise<{
        translations: {
            id: string;
            locale: string;
            title: string;
            page_id: string;
            content: string | null;
        }[];
        blocks: ({
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
        })[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.PageStatus;
        created_at: Date;
        updated_at: Date;
        slug: string;
        type: import("@prisma/client").$Enums.StaticPageType;
        is_required: boolean;
        sort_order: number;
        store_id: string;
    }>;
    update(id: string, dto: UpdatePageDto): Promise<{
        translations: {
            id: string;
            locale: string;
            title: string;
            page_id: string;
            content: string | null;
        }[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.PageStatus;
        created_at: Date;
        updated_at: Date;
        slug: string;
        type: import("@prisma/client").$Enums.StaticPageType;
        is_required: boolean;
        sort_order: number;
        store_id: string;
    }>;
    delete(id: string): Promise<{
        id: string;
        status: import("@prisma/client").$Enums.PageStatus;
        created_at: Date;
        updated_at: Date;
        slug: string;
        type: import("@prisma/client").$Enums.StaticPageType;
        is_required: boolean;
        sort_order: number;
        store_id: string;
    }>;
}
