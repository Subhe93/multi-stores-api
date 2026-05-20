import { PrismaService } from '../../prisma/prisma.service';
import { CreateStoreDto, UpdateStoreDto, UpdateThemeDto, UpdateThemeSelectionDto, UpdateLanguageDto } from './dto/store.dto';
export declare class StoresService {
    private prisma;
    constructor(prisma: PrismaService);
    create(userId: string, dto: CreateStoreDto): Promise<{
        creator: {
            avatar_url: string | null;
            display_name: string;
        };
        language_config: {
            id: string;
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            fallback_locale: string;
            store_id: string;
        } | null;
        static_pages: {
            id: string;
            status: import("@prisma/client").$Enums.PageStatus;
            created_at: Date;
            updated_at: Date;
            slug: string;
            type: import("@prisma/client").$Enums.StaticPageType;
            is_required: boolean;
            sort_order: number;
            store_id: string;
        }[];
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    findByCreator(userId: string): Promise<{
        creator: {
            avatar_url: string | null;
            display_name: string;
            bio: string | null;
        };
        language_config: {
            id: string;
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            fallback_locale: string;
            store_id: string;
        } | null;
        static_pages: ({
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
        })[];
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    findBySlug(slug: string): Promise<{
        creator: {
            avatar_url: string | null;
            display_name: string;
            bio: string | null;
            cover_url: string | null;
        };
        language_config: {
            id: string;
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            fallback_locale: string;
            store_id: string;
        } | null;
        static_pages: ({
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
        })[];
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    update(userId: string, dto: UpdateStoreDto): Promise<{
        language_config: {
            id: string;
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            fallback_locale: string;
            store_id: string;
        } | null;
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    findByCreatorId(creatorId: string): Promise<{
        creator: {
            avatar_url: string | null;
            display_name: string;
        };
        language_config: {
            id: string;
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            fallback_locale: string;
            store_id: string;
        } | null;
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    adminUpdateByCreatorId(creatorId: string, dto: UpdateStoreDto): Promise<{
        language_config: {
            id: string;
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            fallback_locale: string;
            store_id: string;
        } | null;
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    updateTheme(userId: string, dto: UpdateThemeDto): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    updateThemeSelection(userId: string, dto: UpdateThemeSelectionDto): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        name: string;
        description: string | null;
        logo_url: string | null;
        creator_id: string;
        slug: string;
        custom_domain: string | null;
        favicon_url: string | null;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    updateLanguages(userId: string, dto: UpdateLanguageDto): Promise<{
        id: string;
        primary_locale: string;
        secondary_locales: string[];
        auto_translate: boolean;
        fallback_locale: string;
        store_id: string;
    }>;
}
