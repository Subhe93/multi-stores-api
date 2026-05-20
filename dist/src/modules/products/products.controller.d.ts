import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { UserRole, ProductStatus } from '@prisma/client';
export declare class ProductsController {
    private productsService;
    constructor(productsService: ProductsService);
    findAll(page?: number, limit?: number, category_id?: string, product_type?: string, status?: ProductStatus, provider_id?: string, creator_id?: string, owner_type?: 'provider' | 'creator', search?: string, is_featured?: string): Promise<{
        data: ({
            provider: {
                id: string;
                company_name: string;
            } | null;
            category: {
                translations: {
                    id: string;
                    category_id: string;
                    description: string | null;
                    name: string;
                    locale: string;
                }[];
            } & {
                id: string;
                sort_order: number;
                parent_id: string | null;
                slug: string;
                icon: string | null;
                is_active: boolean;
            };
            translations: {
                id: string;
                description: string;
                slug: string;
                product_id: string;
                locale: string;
                title: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                is_featured: boolean;
                sort_order: number;
                product_id: string;
                variant_id: string | null;
                url: string;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                is_active: boolean;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
        } & {
            id: string;
            provider_id: string | null;
            creator_id: string | null;
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
            status: import("@prisma/client").$Enums.ProductStatus;
            is_featured: boolean;
            created_at: Date;
            updated_at: Date;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findMine(userId: string, page?: number, limit?: number, category_id?: string, product_type?: string, status?: ProductStatus, search?: string, is_featured?: string): Promise<{
        data: ({
            provider: {
                id: string;
                company_name: string;
            } | null;
            category: {
                translations: {
                    id: string;
                    category_id: string;
                    description: string | null;
                    name: string;
                    locale: string;
                }[];
            } & {
                id: string;
                sort_order: number;
                parent_id: string | null;
                slug: string;
                icon: string | null;
                is_active: boolean;
            };
            translations: {
                id: string;
                description: string;
                slug: string;
                product_id: string;
                locale: string;
                title: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                is_featured: boolean;
                sort_order: number;
                product_id: string;
                variant_id: string | null;
                url: string;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                is_active: boolean;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
        } & {
            id: string;
            provider_id: string | null;
            creator_id: string | null;
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
            status: import("@prisma/client").$Enums.ProductStatus;
            is_featured: boolean;
            created_at: Date;
            updated_at: Date;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    getImportDetails(id: string): Promise<{
        provider: {
            id: string;
            company_name: string;
        } | null;
        category: {
            translations: {
                id: string;
                category_id: string;
                description: string | null;
                name: string;
                locale: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            parent_id: string | null;
            slug: string;
            icon: string | null;
            is_active: boolean;
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
            provider_id: string | null;
            creator_id: string | null;
            created_at: Date;
            name: string;
            is_default: boolean;
        }) | null;
        translations: {
            id: string;
            description: string;
            slug: string;
            product_id: string;
            locale: string;
            title: string;
            meta_title: string | null;
            meta_desc: string | null;
        }[];
        images: {
            id: string;
            is_featured: boolean;
            sort_order: number;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
        attributes: ({
            template: {
                translations: {
                    id: string;
                    locale: string;
                    template_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                sort_order: number;
                name: string;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.AttributeType;
                is_required: boolean;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                unit: string | null;
                group_name: string | null;
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
                is_featured: boolean;
                sort_order: number;
                product_id: string;
                variant_id: string | null;
                url: string;
                alt_text: string | null;
            }[];
        } & {
            id: string;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            is_active: boolean;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
            options: import("@prisma/client/runtime/library").JsonValue;
        })[];
        tags: {
            id: string;
            product_id: string;
            tag: string;
        }[];
        custom_fields: ({
            translations: {
                id: string;
                locale: string;
                placeholder: string | null;
                label: string;
                option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                field_id: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            name: string;
            product_id: string;
            options: import("@prisma/client/runtime/library").JsonValue | null;
            type: import("@prisma/client").$Enums.CustomFieldType;
            is_required: boolean;
            placeholder: string | null;
            validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        provider_id: string | null;
        creator_id: string | null;
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
        status: import("@prisma/client").$Enums.ProductStatus;
        is_featured: boolean;
        created_at: Date;
        updated_at: Date;
    }>;
    findById(id: string): Promise<{
        category: {
            translations: {
                id: string;
                category_id: string;
                description: string | null;
                name: string;
                locale: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            parent_id: string | null;
            slug: string;
            icon: string | null;
            is_active: boolean;
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
            provider_id: string | null;
            creator_id: string | null;
            created_at: Date;
            name: string;
            is_default: boolean;
        }) | null;
        translations: {
            id: string;
            description: string;
            slug: string;
            product_id: string;
            locale: string;
            title: string;
            meta_title: string | null;
            meta_desc: string | null;
        }[];
        images: {
            id: string;
            is_featured: boolean;
            sort_order: number;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
        attributes: ({
            template: {
                translations: {
                    id: string;
                    locale: string;
                    template_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                sort_order: number;
                name: string;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.AttributeType;
                is_required: boolean;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                unit: string | null;
                group_name: string | null;
            };
        } & {
            id: string;
            product_id: string;
            template_id: string;
            value: import("@prisma/client/runtime/library").JsonValue;
        })[];
        variants: {
            id: string;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            is_active: boolean;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
            options: import("@prisma/client/runtime/library").JsonValue;
        }[];
        tags: {
            id: string;
            product_id: string;
            tag: string;
        }[];
        custom_fields: ({
            translations: {
                id: string;
                locale: string;
                placeholder: string | null;
                label: string;
                option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                field_id: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            name: string;
            product_id: string;
            options: import("@prisma/client/runtime/library").JsonValue | null;
            type: import("@prisma/client").$Enums.CustomFieldType;
            is_required: boolean;
            placeholder: string | null;
            validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        bundles: ({
            bundle: {
                translations: {
                    id: string;
                    name: string;
                    locale: string;
                    bundle_id: string;
                }[];
                offers: ({
                    translations: {
                        id: string;
                        locale: string;
                        title: string;
                        label: string | null;
                        offer_id: string;
                        sticker_text: string | null;
                    }[];
                } & {
                    id: string;
                    sort_order: number;
                    bundle_id: string;
                    quantity: number;
                    discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                    discount_value: import("@prisma/client/runtime/library").Decimal;
                    external_ref: string | null;
                })[];
            } & {
                id: string;
                creator_id: string;
                status: import("@prisma/client").$Enums.BundleStatus;
                created_at: Date;
                updated_at: Date;
            };
        } & {
            product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
                translations: {
                    id: string;
                    description: string | null;
                    name: string;
                    locale: string;
                    creator_category_id: string;
                }[];
            } & {
                id: string;
                creator_id: string;
                created_at: Date;
                updated_at: Date;
                sort_order: number;
                parent_id: string | null;
                slug: string;
                is_active: boolean;
                thumbnail_url: string | null;
                match_rule: import("@prisma/client").$Enums.CreatorCategoryMatchRule;
                match_tags: string[];
            };
        } & {
            sort_order: number;
            product_id: string;
            creator_category_id: string;
        })[];
    } & {
        id: string;
        provider_id: string | null;
        creator_id: string | null;
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
        status: import("@prisma/client").$Enums.ProductStatus;
        is_featured: boolean;
        created_at: Date;
        updated_at: Date;
    }>;
    create(userId: string, userRole: UserRole, dto: CreateProductDto): Promise<{
        category: {
            translations: {
                id: string;
                category_id: string;
                description: string | null;
                name: string;
                locale: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            parent_id: string | null;
            slug: string;
            icon: string | null;
            is_active: boolean;
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
            provider_id: string | null;
            creator_id: string | null;
            created_at: Date;
            name: string;
            is_default: boolean;
        }) | null;
        translations: {
            id: string;
            description: string;
            slug: string;
            product_id: string;
            locale: string;
            title: string;
            meta_title: string | null;
            meta_desc: string | null;
        }[];
        images: {
            id: string;
            is_featured: boolean;
            sort_order: number;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
        attributes: ({
            template: {
                translations: {
                    id: string;
                    locale: string;
                    template_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                sort_order: number;
                name: string;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.AttributeType;
                is_required: boolean;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                unit: string | null;
                group_name: string | null;
            };
        } & {
            id: string;
            product_id: string;
            template_id: string;
            value: import("@prisma/client/runtime/library").JsonValue;
        })[];
        variants: {
            id: string;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            is_active: boolean;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
            options: import("@prisma/client/runtime/library").JsonValue;
        }[];
        tags: {
            id: string;
            product_id: string;
            tag: string;
        }[];
        custom_fields: ({
            translations: {
                id: string;
                locale: string;
                placeholder: string | null;
                label: string;
                option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                field_id: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            name: string;
            product_id: string;
            options: import("@prisma/client/runtime/library").JsonValue | null;
            type: import("@prisma/client").$Enums.CustomFieldType;
            is_required: boolean;
            placeholder: string | null;
            validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        bundles: ({
            bundle: {
                translations: {
                    id: string;
                    name: string;
                    locale: string;
                    bundle_id: string;
                }[];
                offers: ({
                    translations: {
                        id: string;
                        locale: string;
                        title: string;
                        label: string | null;
                        offer_id: string;
                        sticker_text: string | null;
                    }[];
                } & {
                    id: string;
                    sort_order: number;
                    bundle_id: string;
                    quantity: number;
                    discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                    discount_value: import("@prisma/client/runtime/library").Decimal;
                    external_ref: string | null;
                })[];
            } & {
                id: string;
                creator_id: string;
                status: import("@prisma/client").$Enums.BundleStatus;
                created_at: Date;
                updated_at: Date;
            };
        } & {
            product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
                translations: {
                    id: string;
                    description: string | null;
                    name: string;
                    locale: string;
                    creator_category_id: string;
                }[];
            } & {
                id: string;
                creator_id: string;
                created_at: Date;
                updated_at: Date;
                sort_order: number;
                parent_id: string | null;
                slug: string;
                is_active: boolean;
                thumbnail_url: string | null;
                match_rule: import("@prisma/client").$Enums.CreatorCategoryMatchRule;
                match_tags: string[];
            };
        } & {
            sort_order: number;
            product_id: string;
            creator_category_id: string;
        })[];
    } & {
        id: string;
        provider_id: string | null;
        creator_id: string | null;
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
        status: import("@prisma/client").$Enums.ProductStatus;
        is_featured: boolean;
        created_at: Date;
        updated_at: Date;
    }>;
    update(id: string, userId: string, userRole: UserRole, dto: UpdateProductDto): Promise<{
        category: {
            translations: {
                id: string;
                category_id: string;
                description: string | null;
                name: string;
                locale: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            parent_id: string | null;
            slug: string;
            icon: string | null;
            is_active: boolean;
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
            provider_id: string | null;
            creator_id: string | null;
            created_at: Date;
            name: string;
            is_default: boolean;
        }) | null;
        translations: {
            id: string;
            description: string;
            slug: string;
            product_id: string;
            locale: string;
            title: string;
            meta_title: string | null;
            meta_desc: string | null;
        }[];
        images: {
            id: string;
            is_featured: boolean;
            sort_order: number;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
        attributes: ({
            template: {
                translations: {
                    id: string;
                    locale: string;
                    template_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                sort_order: number;
                name: string;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.AttributeType;
                is_required: boolean;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                unit: string | null;
                group_name: string | null;
            };
        } & {
            id: string;
            product_id: string;
            template_id: string;
            value: import("@prisma/client/runtime/library").JsonValue;
        })[];
        variants: {
            id: string;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            is_active: boolean;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
            options: import("@prisma/client/runtime/library").JsonValue;
        }[];
        tags: {
            id: string;
            product_id: string;
            tag: string;
        }[];
        custom_fields: ({
            translations: {
                id: string;
                locale: string;
                placeholder: string | null;
                label: string;
                option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                field_id: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            name: string;
            product_id: string;
            options: import("@prisma/client/runtime/library").JsonValue | null;
            type: import("@prisma/client").$Enums.CustomFieldType;
            is_required: boolean;
            placeholder: string | null;
            validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        bundles: ({
            bundle: {
                translations: {
                    id: string;
                    name: string;
                    locale: string;
                    bundle_id: string;
                }[];
                offers: ({
                    translations: {
                        id: string;
                        locale: string;
                        title: string;
                        label: string | null;
                        offer_id: string;
                        sticker_text: string | null;
                    }[];
                } & {
                    id: string;
                    sort_order: number;
                    bundle_id: string;
                    quantity: number;
                    discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                    discount_value: import("@prisma/client/runtime/library").Decimal;
                    external_ref: string | null;
                })[];
            } & {
                id: string;
                creator_id: string;
                status: import("@prisma/client").$Enums.BundleStatus;
                created_at: Date;
                updated_at: Date;
            };
        } & {
            product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
                translations: {
                    id: string;
                    description: string | null;
                    name: string;
                    locale: string;
                    creator_category_id: string;
                }[];
            } & {
                id: string;
                creator_id: string;
                created_at: Date;
                updated_at: Date;
                sort_order: number;
                parent_id: string | null;
                slug: string;
                is_active: boolean;
                thumbnail_url: string | null;
                match_rule: import("@prisma/client").$Enums.CreatorCategoryMatchRule;
                match_tags: string[];
            };
        } & {
            sort_order: number;
            product_id: string;
            creator_category_id: string;
        })[];
    } & {
        id: string;
        provider_id: string | null;
        creator_id: string | null;
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
        status: import("@prisma/client").$Enums.ProductStatus;
        is_featured: boolean;
        created_at: Date;
        updated_at: Date;
    }>;
    delete(id: string, userId: string, userRole: UserRole): Promise<{
        id: string;
        provider_id: string | null;
        creator_id: string | null;
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
        status: import("@prisma/client").$Enums.ProductStatus;
        is_featured: boolean;
        created_at: Date;
        updated_at: Date;
    }>;
    duplicate(id: string, userId: string, userRole: UserRole): Promise<{
        category: {
            translations: {
                id: string;
                category_id: string;
                description: string | null;
                name: string;
                locale: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            parent_id: string | null;
            slug: string;
            icon: string | null;
            is_active: boolean;
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
            provider_id: string | null;
            creator_id: string | null;
            created_at: Date;
            name: string;
            is_default: boolean;
        }) | null;
        translations: {
            id: string;
            description: string;
            slug: string;
            product_id: string;
            locale: string;
            title: string;
            meta_title: string | null;
            meta_desc: string | null;
        }[];
        images: {
            id: string;
            is_featured: boolean;
            sort_order: number;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
        attributes: ({
            template: {
                translations: {
                    id: string;
                    locale: string;
                    template_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                sort_order: number;
                name: string;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.AttributeType;
                is_required: boolean;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                unit: string | null;
                group_name: string | null;
            };
        } & {
            id: string;
            product_id: string;
            template_id: string;
            value: import("@prisma/client/runtime/library").JsonValue;
        })[];
        variants: {
            id: string;
            compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
            sku: string | null;
            stock_quantity: number | null;
            is_active: boolean;
            product_id: string;
            price_adjustment: import("@prisma/client/runtime/library").Decimal;
            options: import("@prisma/client/runtime/library").JsonValue;
        }[];
        tags: {
            id: string;
            product_id: string;
            tag: string;
        }[];
        custom_fields: ({
            translations: {
                id: string;
                locale: string;
                placeholder: string | null;
                label: string;
                option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                field_id: string;
            }[];
        } & {
            id: string;
            sort_order: number;
            name: string;
            product_id: string;
            options: import("@prisma/client/runtime/library").JsonValue | null;
            type: import("@prisma/client").$Enums.CustomFieldType;
            is_required: boolean;
            placeholder: string | null;
            validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        bundles: ({
            bundle: {
                translations: {
                    id: string;
                    name: string;
                    locale: string;
                    bundle_id: string;
                }[];
                offers: ({
                    translations: {
                        id: string;
                        locale: string;
                        title: string;
                        label: string | null;
                        offer_id: string;
                        sticker_text: string | null;
                    }[];
                } & {
                    id: string;
                    sort_order: number;
                    bundle_id: string;
                    quantity: number;
                    discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                    discount_value: import("@prisma/client/runtime/library").Decimal;
                    external_ref: string | null;
                })[];
            } & {
                id: string;
                creator_id: string;
                status: import("@prisma/client").$Enums.BundleStatus;
                created_at: Date;
                updated_at: Date;
            };
        } & {
            product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
                translations: {
                    id: string;
                    description: string | null;
                    name: string;
                    locale: string;
                    creator_category_id: string;
                }[];
            } & {
                id: string;
                creator_id: string;
                created_at: Date;
                updated_at: Date;
                sort_order: number;
                parent_id: string | null;
                slug: string;
                is_active: boolean;
                thumbnail_url: string | null;
                match_rule: import("@prisma/client").$Enums.CreatorCategoryMatchRule;
                match_tags: string[];
            };
        } & {
            sort_order: number;
            product_id: string;
            creator_category_id: string;
        })[];
    } & {
        id: string;
        provider_id: string | null;
        creator_id: string | null;
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
        status: import("@prisma/client").$Enums.ProductStatus;
        is_featured: boolean;
        created_at: Date;
        updated_at: Date;
    }>;
    updateStatus(id: string, status: ProductStatus, userId: string, userRole: UserRole): Promise<{
        id: string;
        provider_id: string | null;
        creator_id: string | null;
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
        status: import("@prisma/client").$Enums.ProductStatus;
        is_featured: boolean;
        created_at: Date;
        updated_at: Date;
    }>;
    addImage(id: string, body: {
        url: string;
        alt_text?: string;
        sort_order?: number;
        is_featured?: boolean;
        variant_id?: string;
    }): Promise<{
        id: string;
        is_featured: boolean;
        sort_order: number;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }>;
    getImages(id: string): Promise<{
        id: string;
        is_featured: boolean;
        sort_order: number;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }[]>;
    deleteImage(imageId: string): Promise<{
        id: string;
        is_featured: boolean;
        sort_order: number;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }>;
    reorderImages(id: string, imageIds: string[]): Promise<{
        id: string;
        is_featured: boolean;
        sort_order: number;
        product_id: string;
        variant_id: string | null;
        url: string;
        alt_text: string | null;
    }[]>;
}
