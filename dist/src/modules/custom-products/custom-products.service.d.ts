import { PrismaService } from '../../prisma/prisma.service';
import { CreateCustomProductDto, UpdateCustomProductDto } from './dto/custom-product.dto';
import { NotificationsService } from '../notifications/notifications.service';
export declare class CustomProductsService {
    private prisma;
    private notificationsService;
    constructor(prisma: PrismaService, notificationsService: NotificationsService);
    private assertCustomProductCompatibleWithBundles;
    private assertCreatorOwns;
    private assertProviderOwnsBase;
    private readonly includes;
    private attachCreatorCategories;
    private assertSlugsAvailable;
    checkSlug(userId: string, slug: string, excludeId?: string): Promise<{
        available: boolean;
        reason: "empty";
        conflictsWith?: undefined;
    } | {
        available: boolean;
        conflictsWith: "product" | "custom_product" | null;
        reason?: undefined;
    }>;
    private assertBundlesOwnedByCreator;
    create(userId: string, dto: CreateCustomProductDto): Promise<{
        creator: {
            display_name: string;
        };
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
            };
        } & {
            custom_product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
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
            };
        } & {
            sort_order: number;
            custom_product_id: string;
            creator_category_id: string;
        })[];
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
        mockup_images: {
            id: string;
            sort_order: number;
            custom_product_id: string;
            url: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            };
        } & {
            id: string;
            custom_product_id: string;
            variant_id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
        })[];
        field_values: ({
            custom_field: {
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
    }>;
    findByCreator(userId: string, page?: number, limit?: number): Promise<{
        data: ({
            creator: {
                display_name: string;
            };
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
                };
            } & {
                custom_product_id: string;
                bundle_id: string;
            })[];
            creator_categories: ({
                creator_category: {
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
                };
            } & {
                sort_order: number;
                custom_product_id: string;
                creator_category_id: string;
            })[];
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
                created_at: Date;
                sort_order: number;
                custom_product_id: string;
            })[];
            mockup_images: {
                id: string;
                sort_order: number;
                custom_product_id: string;
                url: string;
            }[];
            selected_variants: ({
                variant: {
                    id: string;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    product_id: string;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                };
            } & {
                id: string;
                custom_product_id: string;
                variant_id: string;
                custom_price: import("@prisma/client/runtime/library").Decimal | null;
            })[];
            field_values: ({
                custom_field: {
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
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findById(id: string): Promise<{
        creator: {
            display_name: string;
        };
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
            };
        } & {
            custom_product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
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
            };
        } & {
            sort_order: number;
            custom_product_id: string;
            creator_category_id: string;
        })[];
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
        mockup_images: {
            id: string;
            sort_order: number;
            custom_product_id: string;
            url: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            };
        } & {
            id: string;
            custom_product_id: string;
            variant_id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
        })[];
        field_values: ({
            custom_field: {
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
    }>;
    update(id: string, dto: UpdateCustomProductDto, userId?: string): Promise<{
        creator: {
            display_name: string;
        };
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
            };
        } & {
            custom_product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
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
            };
        } & {
            sort_order: number;
            custom_product_id: string;
            creator_category_id: string;
        })[];
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
        mockup_images: {
            id: string;
            sort_order: number;
            custom_product_id: string;
            url: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            };
        } & {
            id: string;
            custom_product_id: string;
            variant_id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
        })[];
        field_values: ({
            custom_field: {
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
    }>;
    delete(id: string, userId?: string): Promise<{
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
    }>;
    duplicate(id: string, userId: string): Promise<{
        creator: {
            display_name: string;
        };
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
            };
        } & {
            custom_product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
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
            };
        } & {
            sort_order: number;
            custom_product_id: string;
            creator_category_id: string;
        })[];
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
        mockup_images: {
            id: string;
            sort_order: number;
            custom_product_id: string;
            url: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            };
        } & {
            id: string;
            custom_product_id: string;
            variant_id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
        })[];
        field_values: ({
            custom_field: {
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
    }>;
    submitForReview(id: string, userId: string): Promise<{
        creator: {
            display_name: string;
        };
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
            };
        } & {
            custom_product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
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
            };
        } & {
            sort_order: number;
            custom_product_id: string;
            creator_category_id: string;
        })[];
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
        mockup_images: {
            id: string;
            sort_order: number;
            custom_product_id: string;
            url: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            };
        } & {
            id: string;
            custom_product_id: string;
            variant_id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
        })[];
        field_values: ({
            custom_field: {
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
    }>;
    approve(id: string, userId: string): Promise<{
        creator: {
            display_name: string;
        };
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
            };
        } & {
            custom_product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
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
            };
        } & {
            sort_order: number;
            custom_product_id: string;
            creator_category_id: string;
        })[];
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
        mockup_images: {
            id: string;
            sort_order: number;
            custom_product_id: string;
            url: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            };
        } & {
            id: string;
            custom_product_id: string;
            variant_id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
        })[];
        field_values: ({
            custom_field: {
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
    }>;
    reject(id: string, userId: string, reason: string): Promise<{
        creator: {
            display_name: string;
        };
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
            };
        } & {
            custom_product_id: string;
            bundle_id: string;
        })[];
        creator_categories: ({
            creator_category: {
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
            };
        } & {
            sort_order: number;
            custom_product_id: string;
            creator_category_id: string;
        })[];
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
        mockup_images: {
            id: string;
            sort_order: number;
            custom_product_id: string;
            url: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            };
        } & {
            id: string;
            custom_product_id: string;
            variant_id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
        })[];
        field_values: ({
            custom_field: {
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
    }>;
    findPendingReviewsForProvider(userId: string, page?: number, limit?: number): Promise<{
        data: ({
            creator: {
                display_name: string;
            };
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
                };
            } & {
                custom_product_id: string;
                bundle_id: string;
            })[];
            creator_categories: ({
                creator_category: {
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
                };
            } & {
                sort_order: number;
                custom_product_id: string;
                creator_category_id: string;
            })[];
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
                created_at: Date;
                sort_order: number;
                custom_product_id: string;
            })[];
            mockup_images: {
                id: string;
                sort_order: number;
                custom_product_id: string;
                url: string;
            }[];
            selected_variants: ({
                variant: {
                    id: string;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    product_id: string;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                };
            } & {
                id: string;
                custom_product_id: string;
                variant_id: string;
                custom_price: import("@prisma/client/runtime/library").Decimal | null;
            })[];
            field_values: ({
                custom_field: {
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
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    private notifyProviderOfSubmission;
    createFaq(customProductId: string, dto: {
        sort_order?: number;
        translations: {
            locale: string;
            question: string;
            answer: string;
        }[];
    }): Promise<{
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
    }>;
    findFaqs(customProductId: string): Promise<({
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
    })[]>;
    updateFaq(faqId: string, dto: {
        sort_order?: number;
        translations?: {
            locale: string;
            question: string;
            answer: string;
        }[];
    }): Promise<{
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
    }>;
    deleteFaq(faqId: string): Promise<{
        id: string;
        created_at: Date;
        sort_order: number;
        custom_product_id: string;
    }>;
    private validatePricing;
}
