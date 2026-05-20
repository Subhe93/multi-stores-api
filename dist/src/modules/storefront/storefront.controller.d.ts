import { StorefrontService } from './storefront.service';
export declare class StorefrontController {
    private storefrontService;
    constructor(storefrontService: StorefrontService);
    getStore(slug: string): Promise<{
        currency: string;
        pages: ({
            translations: {
                locale: string;
                title: string;
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
        theme_key: any;
        theme_customizations: any;
        theme: {
            primaryColor: any;
            secondaryColor: any;
            fontFamily: any;
            typography: any;
            header: any;
            templateId: any;
            socials: any;
            contact: any;
            seo: any;
            translations: any;
        };
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
                locale: string;
                title: string;
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
        theme_config: import("@prisma/client/runtime/library").JsonValue;
        is_active: boolean;
    }>;
    getProducts(slug: string, page?: number, limit?: number, category_id?: string, creator_category?: string, search?: string, locale?: string): Promise<any[]>;
    getProduct(slug: string, productSlug: string, locale?: string): Promise<{
        shipping_profile: any;
        base_price: number;
        compare_at_price: number | undefined;
        variants: any[];
        creator_categories: any;
        promotions: {
            id: string;
            type: import("@prisma/client").$Enums.PromotionType;
            value: number;
            conditions: import("@prisma/client/runtime/library").JsonValue;
            starts_at: Date;
            expires_at: Date | null;
            translations: {
                id: string;
                description: string | null;
                locale: string;
                title: string;
                promotion_id: string;
            }[];
        }[];
        bundles: ({
            translations: {
                id: string;
                name: string;
                locale: string;
                bundle_id: string;
            }[];
            offers: ({
                translations: {
                    id: string;
                    label: string | null;
                    locale: string;
                    title: string;
                    sticker_text: string | null;
                    offer_id: string;
                }[];
            } & {
                id: string;
                sort_order: number;
                quantity: number;
                discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                discount_value: import("@prisma/client/runtime/library").Decimal;
                external_ref: string | null;
                bundle_id: string;
            })[];
        } & {
            id: string;
            status: import("@prisma/client").$Enums.BundleStatus;
            created_at: Date;
            updated_at: Date;
            creator_id: string;
        })[];
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
        category: {
            translations: {
                id: string;
                name: string;
                description: string | null;
                locale: string;
                category_id: string;
            }[];
        } & {
            id: string;
            slug: string;
            is_active: boolean;
            sort_order: number;
            parent_id: string | null;
            icon: string | null;
        };
        images: {
            id: string;
            sort_order: number;
            is_featured: boolean;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
        attributes: ({
            template: {
                translations: {
                    id: string;
                    label: string;
                    locale: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                    template_id: string;
                }[];
            } & {
                id: string;
                name: string;
                type: import("@prisma/client").$Enums.AttributeType;
                unit: string | null;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                is_required: boolean;
                group_name: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                sort_order: number;
            };
        } & {
            id: string;
            product_id: string;
            template_id: string;
            value: import("@prisma/client/runtime/library").JsonValue;
        })[];
        tags: {
            id: string;
            product_id: string;
            tag: string;
        }[];
        custom_fields: ({
            translations: {
                id: string;
                label: string;
                locale: string;
                option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                placeholder: string | null;
                field_id: string;
            }[];
        } & {
            id: string;
            name: string;
            type: import("@prisma/client").$Enums.CustomFieldType;
            options: import("@prisma/client/runtime/library").JsonValue | null;
            is_required: boolean;
            validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
            sort_order: number;
            product_id: string;
            placeholder: string | null;
            linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
        })[];
        faqs: ({
            translations: {
                id: string;
                locale: string;
                faq_id: string;
                question: string;
                answer: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            product_id: string;
        })[];
        id: string;
        status: import("@prisma/client").$Enums.ProductStatus;
        created_at: Date;
        updated_at: Date;
        creator_id: string | null;
        provider_id: string | null;
        category_id: string;
        product_type: import("@prisma/client").$Enums.ProductType;
        customization_type: import("@prisma/client").$Enums.CustomizationType | null;
        cost_price: import("@prisma/client/runtime/library").Decimal | null;
        sku: string | null;
        track_inventory: boolean;
        stock_quantity: number | null;
        weight: import("@prisma/client/runtime/library").Decimal | null;
        weight_unit: string | null;
        variant_option_config: import("@prisma/client/runtime/library").JsonValue | null;
        shipping_profile_id: string | null;
        is_featured: boolean;
        field_values?: undefined;
        pricing_type?: undefined;
        _type?: undefined;
    } | {
        id: string;
        base_price: number;
        compare_at_price: number | undefined;
        status: import("@prisma/client").$Enums.ProductStatus;
        product_type: import("@prisma/client").$Enums.ProductType;
        customization_type: import("@prisma/client").$Enums.CustomizationType | null;
        variant_option_config: import("@prisma/client/runtime/library").JsonValue;
        translations: {
            id: string;
            description: string | null;
            slug: string;
            locale: string;
            custom_product_id: string;
            title: string;
        }[];
        images: {
            id: string;
            sort_order: number;
            is_featured: boolean;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[] | {
            url: string;
            alt_text: null;
            sort_order: number;
        }[];
        attributes: ({
            template: {
                translations: {
                    id: string;
                    label: string;
                    locale: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                    template_id: string;
                }[];
            } & {
                id: string;
                name: string;
                type: import("@prisma/client").$Enums.AttributeType;
                unit: string | null;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                is_required: boolean;
                group_name: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                sort_order: number;
            };
        } & {
            id: string;
            product_id: string;
            template_id: string;
            value: import("@prisma/client/runtime/library").JsonValue;
        })[];
        variants: any;
        tags: {
            id: string;
            product_id: string;
            tag: string;
        }[];
        category: {
            translations: {
                id: string;
                name: string;
                description: string | null;
                locale: string;
                category_id: string;
            }[];
        } & {
            id: string;
            slug: string;
            is_active: boolean;
            sort_order: number;
            parent_id: string | null;
            icon: string | null;
        };
        creator_categories: any;
        custom_fields: ({
            translations: {
                id: string;
                label: string;
                locale: string;
                option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                placeholder: string | null;
                field_id: string;
            }[];
        } & {
            id: string;
            name: string;
            type: import("@prisma/client").$Enums.CustomFieldType;
            options: import("@prisma/client/runtime/library").JsonValue | null;
            is_required: boolean;
            validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
            sort_order: number;
            product_id: string;
            placeholder: string | null;
            linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
        })[];
        faqs: (({
            translations: {
                id: string;
                locale: string;
                faq_id: string;
                question: string;
                answer: string;
            }[];
        } & {
            id: string;
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        }) | ({
            translations: {
                id: string;
                locale: string;
                faq_id: string;
                question: string;
                answer: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            product_id: string;
        }))[];
        field_values: ({
            custom_field: {
                translations: {
                    id: string;
                    label: string;
                    locale: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                    placeholder: string | null;
                    field_id: string;
                }[];
            } & {
                id: string;
                name: string;
                type: import("@prisma/client").$Enums.CustomFieldType;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                is_required: boolean;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                sort_order: number;
                product_id: string;
                placeholder: string | null;
                linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
            };
        } & {
            id: string;
            custom_product_id: string;
            value: string | null;
            custom_field_id: string;
            file_url: string | null;
        })[];
        pricing_type: import("@prisma/client").$Enums.PricingType;
        shipping_profile: any;
        promotions: {
            id: string;
            type: import("@prisma/client").$Enums.PromotionType;
            value: number;
            conditions: import("@prisma/client/runtime/library").JsonValue;
            starts_at: Date;
            expires_at: Date | null;
            translations: {
                id: string;
                description: string | null;
                locale: string;
                title: string;
                promotion_id: string;
            }[];
        }[];
        bundles: ({
            translations: {
                id: string;
                name: string;
                locale: string;
                bundle_id: string;
            }[];
            offers: ({
                translations: {
                    id: string;
                    label: string | null;
                    locale: string;
                    title: string;
                    sticker_text: string | null;
                    offer_id: string;
                }[];
            } & {
                id: string;
                sort_order: number;
                quantity: number;
                discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                discount_value: import("@prisma/client/runtime/library").Decimal;
                external_ref: string | null;
                bundle_id: string;
            })[];
        } & {
            id: string;
            status: import("@prisma/client").$Enums.BundleStatus;
            created_at: Date;
            updated_at: Date;
            creator_id: string;
        })[];
        _type: "custom_product";
    }>;
    getCategories(slug: string): Promise<({
        translations: {
            id: string;
            name: string;
            description: string | null;
            locale: string;
            category_id: string;
        }[];
    } & {
        id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        icon: string | null;
    })[]>;
    getCreatorCategories(slug: string): Promise<({
        translations: {
            id: string;
            name: string;
            description: string | null;
            locale: string;
            creator_category_id: string;
        }[];
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        creator_id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        thumbnail_url: string | null;
        match_rule: import("@prisma/client").$Enums.CreatorCategoryMatchRule;
        match_tags: string[];
    } & {
        children: ({
            translations: {
                id: string;
                name: string;
                description: string | null;
                locale: string;
                creator_category_id: string;
            }[];
        } & {
            id: string;
            created_at: Date;
            updated_at: Date;
            creator_id: string;
            slug: string;
            is_active: boolean;
            sort_order: number;
            parent_id: string | null;
            thumbnail_url: string | null;
            match_rule: import("@prisma/client").$Enums.CreatorCategoryMatchRule;
            match_tags: string[];
        } & any)[];
    })[]>;
    getMenus(slug: string): Promise<{
        id: string;
        key: string;
        name: string;
        items: {
            id: string;
            label: string;
            sort_order: number;
            parent_id: string | null;
            url: string;
            label_i18n: import("@prisma/client/runtime/library").JsonValue;
            open_in_new_tab: boolean;
        }[];
    }[]>;
    getPage(slug: string, pageSlug: string): Promise<{
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
    getHome(slug: string): Promise<{
        id: string;
        type: import("@prisma/client").$Enums.PageType;
        slug: string | null;
        seo: import("@prisma/client/runtime/library").JsonValue;
        snapshot: import("@prisma/client/runtime/library").JsonValue;
        published_at: Date | null;
    } | null>;
    getProductTemplate(slug: string): Promise<{
        id: string;
        type: import("@prisma/client").$Enums.PageType;
        slug: string | null;
        seo: import("@prisma/client/runtime/library").JsonValue;
        snapshot: import("@prisma/client/runtime/library").JsonValue;
        published_at: Date | null;
    } | null>;
    getHeader(slug: string): Promise<{
        id: string;
        type: import("@prisma/client").$Enums.PageType;
        slug: string | null;
        seo: import("@prisma/client/runtime/library").JsonValue;
        snapshot: import("@prisma/client/runtime/library").JsonValue;
        published_at: Date | null;
    } | null>;
    getFooter(slug: string): Promise<{
        id: string;
        type: import("@prisma/client").$Enums.PageType;
        slug: string | null;
        seo: import("@prisma/client/runtime/library").JsonValue;
        snapshot: import("@prisma/client/runtime/library").JsonValue;
        published_at: Date | null;
    } | null>;
    getSampleProduct(slug: string): Promise<{
        id: string;
        slug: string;
        base_price: number;
        compare_at_price: number | undefined;
        translations: {
            description: string;
            slug: string;
            locale: string;
            title: string;
        }[];
        images: {
            url: string;
            alt_text: string | null;
            sort_order: number;
        }[];
        variants: {
            id: string;
            price: number;
            stock: number | undefined;
            sku: string | undefined;
        }[];
        faqs: ({
            translations: {
                id: string;
                locale: string;
                faq_id: string;
                question: string;
                answer: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            product_id: string;
        })[];
    } | null>;
    getPublishedPage(slug: string, pageSlug: string, type?: 'STATIC' | 'LANDING'): Promise<{
        id: string;
        type: import("@prisma/client").$Enums.PageType;
        slug: string | null;
        seo: import("@prisma/client/runtime/library").JsonValue;
        snapshot: import("@prisma/client/runtime/library").JsonValue;
        published_at: Date | null;
    } | null>;
    getSitemapData(slug: string): Promise<{
        locales: string[];
        primaryLocale: string;
        home: {
            lastmod: Date;
        } | null;
        static_pages: {
            slug: string;
            lastmod: Date;
        }[];
        landing_pages: {
            slug: string;
            lastmod: Date;
        }[];
        products: {
            slug: string;
            lastmod: Date;
        }[];
    }>;
}
