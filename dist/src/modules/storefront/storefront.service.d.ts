import { PrismaService } from '../../prisma/prisma.service';
export declare class StorefrontService {
    private prisma;
    constructor(prisma: PrismaService);
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
        theme: {
            primaryColor: any;
            secondaryColor: any;
            fontFamily: any;
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
    getProducts(slug: string, filters: {
        page?: number;
        limit?: number;
        category_id?: string;
        search?: string;
        locale?: string;
    }): Promise<any[]>;
    private getActivePromotionsForProduct;
    getProduct(slug: string, productSlug: string, locale?: string): Promise<{
        shipping_profile: any;
        base_price: number;
        compare_at_price: number | undefined;
        variants: any[];
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
            title: string;
            custom_product_id: string;
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
            value: string | null;
            custom_product_id: string;
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
    private computeVariants;
    private computeVariantPrice;
    private computeDisplayPrice;
}
