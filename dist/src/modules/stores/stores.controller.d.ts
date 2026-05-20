import { StoresService } from './stores.service';
import { CreateStoreDto, UpdateStoreDto, UpdateThemeDto, UpdateThemeSelectionDto, UpdateLanguageDto } from './dto/store.dto';
export declare class StoresController {
    private storesService;
    constructor(storesService: StoresService);
    findByCreatorId(creatorId: string): Promise<{
        creator: {
            display_name: string;
            avatar_url: string | null;
        };
        language_config: {
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            id: string;
            fallback_locale: string;
            store_id: string;
        } | null;
    } & {
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    adminUpdate(creatorId: string, dto: UpdateStoreDto): Promise<{
        language_config: {
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            id: string;
            fallback_locale: string;
            store_id: string;
        } | null;
    } & {
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    findBySlug(slug: string): Promise<{
        creator: {
            display_name: string;
            bio: string | null;
            avatar_url: string | null;
            cover_url: string | null;
        };
        language_config: {
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            id: string;
            fallback_locale: string;
            store_id: string;
        } | null;
        static_pages: ({
            translations: {
                id: string;
                page_id: string;
                locale: string;
                title: string;
                content: string | null;
            }[];
        } & {
            slug: string;
            id: string;
            created_at: Date;
            updated_at: Date;
            type: import("@prisma/client").$Enums.StaticPageType;
            is_required: boolean;
            sort_order: number;
            status: import("@prisma/client").$Enums.PageStatus;
            store_id: string;
        })[];
    } & {
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    create(userId: string, dto: CreateStoreDto): Promise<{
        creator: {
            display_name: string;
            avatar_url: string | null;
        };
        language_config: {
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            id: string;
            fallback_locale: string;
            store_id: string;
        } | null;
        static_pages: {
            slug: string;
            id: string;
            created_at: Date;
            updated_at: Date;
            type: import("@prisma/client").$Enums.StaticPageType;
            is_required: boolean;
            sort_order: number;
            status: import("@prisma/client").$Enums.PageStatus;
            store_id: string;
        }[];
    } & {
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    getMyStore(userId: string): Promise<{
        creator: {
            display_name: string;
            bio: string | null;
            avatar_url: string | null;
        };
        language_config: {
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            id: string;
            fallback_locale: string;
            store_id: string;
        } | null;
        static_pages: ({
            translations: {
                id: string;
                page_id: string;
                locale: string;
                title: string;
                content: string | null;
            }[];
        } & {
            slug: string;
            id: string;
            created_at: Date;
            updated_at: Date;
            type: import("@prisma/client").$Enums.StaticPageType;
            is_required: boolean;
            sort_order: number;
            status: import("@prisma/client").$Enums.PageStatus;
            store_id: string;
        })[];
    } & {
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    update(userId: string, dto: UpdateStoreDto): Promise<{
        language_config: {
            primary_locale: string;
            secondary_locales: string[];
            auto_translate: boolean;
            id: string;
            fallback_locale: string;
            store_id: string;
        } | null;
    } & {
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    updateTheme(userId: string, dto: UpdateThemeDto): Promise<{
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    updateThemeSelection(userId: string, dto: UpdateThemeSelectionDto): Promise<{
        slug: string;
        name: string;
        description: string | null;
        logo_url: string | null;
        favicon_url: string | null;
        custom_domain: string | null;
        is_active: boolean;
        cache_enabled: boolean;
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        theme_key: string;
        theme_customizations: import("@prisma/client/runtime/library").JsonValue;
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
    }>;
    updateLanguages(userId: string, dto: UpdateLanguageDto): Promise<{
        primary_locale: string;
        secondary_locales: string[];
        auto_translate: boolean;
        id: string;
        fallback_locale: string;
        store_id: string;
    }>;
    flushCache(userId: string): Promise<{
        flushed: boolean;
        slug: string;
    }>;
}
