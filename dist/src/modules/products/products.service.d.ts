import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { UserRole, ProductStatus } from '@prisma/client';
export declare class ProductsService {
    private prisma;
    constructor(prisma: PrismaService);
    private readonly productIncludes;
    create(userId: string, userRole: UserRole, dto: CreateProductDto): Promise<{
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
        shipping_profile: ({
            zones: {
                id: string;
                name: string;
                profile_id: string;
                countries: string[];
                base_cost: import("@prisma/client/runtime/library").Decimal;
                per_item_cost: import("@prisma/client/runtime/library").Decimal;
                free_threshold: import("@prisma/client/runtime/library").Decimal | null;
                estimated_days_min: number;
                estimated_days_max: number;
            }[];
        } & {
            id: string;
            created_at: Date;
            name: string;
            creator_id: string | null;
            is_default: boolean;
            provider_id: string | null;
        }) | null;
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
        variants: {
            id: string;
            is_active: boolean;
            options: import("@prisma/client/runtime/library").JsonValue;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
        }[];
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
    }>;
    findAll(filters: {
        page?: number;
        limit?: number;
        category_id?: string;
        product_type?: string;
        status?: ProductStatus;
        provider_id?: string;
        creator_id?: string;
        search?: string;
        is_featured?: boolean;
    }): Promise<{
        data: ({
            provider: {
                id: string;
                company_name: string;
            } | null;
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
            variants: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
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
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findById(id: string): Promise<{
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
        shipping_profile: ({
            zones: {
                id: string;
                name: string;
                profile_id: string;
                countries: string[];
                base_cost: import("@prisma/client/runtime/library").Decimal;
                per_item_cost: import("@prisma/client/runtime/library").Decimal;
                free_threshold: import("@prisma/client/runtime/library").Decimal | null;
                estimated_days_min: number;
                estimated_days_max: number;
            }[];
        } & {
            id: string;
            created_at: Date;
            name: string;
            creator_id: string | null;
            is_default: boolean;
            provider_id: string | null;
        }) | null;
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
        variants: {
            id: string;
            is_active: boolean;
            options: import("@prisma/client/runtime/library").JsonValue;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
        }[];
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
    }>;
    update(id: string, userId: string, userRole: UserRole, dto: UpdateProductDto): Promise<{
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
        shipping_profile: ({
            zones: {
                id: string;
                name: string;
                profile_id: string;
                countries: string[];
                base_cost: import("@prisma/client/runtime/library").Decimal;
                per_item_cost: import("@prisma/client/runtime/library").Decimal;
                free_threshold: import("@prisma/client/runtime/library").Decimal | null;
                estimated_days_min: number;
                estimated_days_max: number;
            }[];
        } & {
            id: string;
            created_at: Date;
            name: string;
            creator_id: string | null;
            is_default: boolean;
            provider_id: string | null;
        }) | null;
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
        variants: {
            id: string;
            is_active: boolean;
            options: import("@prisma/client/runtime/library").JsonValue;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
        }[];
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
    }>;
    delete(id: string, userId: string, userRole: UserRole): Promise<{
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
    }>;
    updateStatus(id: string, status: ProductStatus, userId: string, userRole: UserRole): Promise<{
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
    }>;
    addImage(productId: string, url: string, altText?: string, sortOrder?: number, isFeatured?: boolean, variantId?: string): Promise<{
        id: string;
        sort_order: number;
        is_featured: boolean;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }>;
    getImages(productId: string): Promise<{
        id: string;
        sort_order: number;
        is_featured: boolean;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }[]>;
    deleteImage(imageId: string): Promise<{
        id: string;
        sort_order: number;
        is_featured: boolean;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }>;
    reorderImages(productId: string, imageIds: string[]): Promise<{
        id: string;
        sort_order: number;
        is_featured: boolean;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }[]>;
    getImportDetails(id: string): Promise<{
        provider: {
            id: string;
            company_name: string;
        } | null;
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
        shipping_profile: ({
            zones: {
                id: string;
                name: string;
                profile_id: string;
                countries: string[];
                base_cost: import("@prisma/client/runtime/library").Decimal;
                per_item_cost: import("@prisma/client/runtime/library").Decimal;
                free_threshold: import("@prisma/client/runtime/library").Decimal | null;
                estimated_days_min: number;
                estimated_days_max: number;
            }[];
        } & {
            id: string;
            created_at: Date;
            name: string;
            creator_id: string | null;
            is_default: boolean;
            provider_id: string | null;
        }) | null;
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
        variants: ({
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
            is_active: boolean;
            options: import("@prisma/client/runtime/library").JsonValue;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
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
    }>;
    private checkOwnership;
}
