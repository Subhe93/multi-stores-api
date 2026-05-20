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
    getMyStores(userId: string, page?: number, limit?: number): Promise<{
        data: {
            products_using_count: number;
            creator: {
                avatar_url: string | null;
                verified: boolean;
                display_name: string;
            };
            language_config: {
                primary_locale: string;
            } | null;
            _count: {
                static_pages: number;
            };
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
            cache_enabled: boolean;
        }[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    getMyStoreById(userId: string, storeId: string): Promise<{
        custom_products_using: ({
            translations: {
                id: string;
                description: string | null;
                slug: string;
                locale: string;
                custom_product_id: string;
                title: string;
            }[];
            product: {
                translations: {
                    id: string;
                    description: string;
                    slug: string;
                    locale: string;
                    product_id: string;
                    title: string;
                    meta_title: string | null;
                    meta_desc: string | null;
                }[];
                images: {
                    id: string;
                    sort_order: number;
                    is_featured: boolean;
                    product_id: string;
                    variant_id: string | null;
                    url: string;
                    alt_text: string | null;
                }[];
            } & {
                id: string;
                status: import("@prisma/client").$Enums.ProductStatus;
                created_at: Date;
                updated_at: Date;
                creator_id: string | null;
                provider_id: string | null;
                category_id: string;
                product_type: import("@prisma/client").$Enums.ProductType;
                customization_type: import("@prisma/client").$Enums.CustomizationType | null;
                base_price: import("@prisma/client/runtime/library").Decimal;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                cost_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                track_inventory: boolean;
                stock_quantity: number | null;
                weight: import("@prisma/client/runtime/library").Decimal | null;
                weight_unit: string | null;
                variant_option_config: import("@prisma/client/runtime/library").JsonValue | null;
                shipping_profile_id: string | null;
                is_featured: boolean;
            };
            mockup_images: {
                id: string;
                sort_order: number;
                custom_product_id: string;
                url: string;
            }[];
            selected_variants: {
                custom_price: import("@prisma/client/runtime/library").Decimal | null;
                variant: {
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                };
            }[];
        } & {
            id: string;
            status: import("@prisma/client").$Enums.ProductStatus;
            created_at: Date;
            updated_at: Date;
            creator_id: string;
            product_id: string;
            import_mode: import("@prisma/client").$Enums.ImportMode;
            pricing_type: import("@prisma/client").$Enums.PricingType;
            final_price: import("@prisma/client/runtime/library").Decimal;
            margin_amount: import("@prisma/client/runtime/library").Decimal | null;
            rejection_reason: string | null;
            submitted_at: Date | null;
            reviewed_at: Date | null;
            reviewed_by: string | null;
        })[];
        creator: {
            avatar_url: string | null;
            verified: boolean;
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
        cache_enabled: boolean;
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
