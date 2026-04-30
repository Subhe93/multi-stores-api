import { CustomProductsService } from './custom-products.service';
import { CreateCustomProductDto, UpdateCustomProductDto } from './dto/custom-product.dto';
declare class FaqTranslationDto {
    locale: string;
    question: string;
    answer: string;
}
declare class CreateCustomProductFaqDto {
    sort_order?: number;
    translations: FaqTranslationDto[];
}
declare class UpdateCustomProductFaqDto {
    sort_order?: number;
    translations?: FaqTranslationDto[];
}
declare class RejectCustomProductDto {
    reason: string;
}
export declare class CustomProductsController {
    private customProductsService;
    constructor(customProductsService: CustomProductsService);
    create(userId: string, dto: CreateCustomProductDto): Promise<{
        creator: {
            display_name: string;
        };
        translations: {
            id: string;
            description: string | null;
            slug: string;
            locale: string;
            title: string;
            custom_product_id: string;
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
            url: string;
            custom_product_id: string;
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
            variant_id: string;
            custom_product_id: string;
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
            value: string | null;
            custom_product_id: string;
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
    findMyCustomProducts(userId: string, page?: number, limit?: number): Promise<{
        data: ({
            creator: {
                display_name: string;
            };
            translations: {
                id: string;
                description: string | null;
                slug: string;
                locale: string;
                title: string;
                custom_product_id: string;
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
                url: string;
                custom_product_id: string;
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
                variant_id: string;
                custom_product_id: string;
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
                value: string | null;
                custom_product_id: string;
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
    pendingReviews(userId: string, page?: number, limit?: number): Promise<{
        data: ({
            creator: {
                display_name: string;
            };
            translations: {
                id: string;
                description: string | null;
                slug: string;
                locale: string;
                title: string;
                custom_product_id: string;
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
                url: string;
                custom_product_id: string;
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
                variant_id: string;
                custom_product_id: string;
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
                value: string | null;
                custom_product_id: string;
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
        translations: {
            id: string;
            description: string | null;
            slug: string;
            locale: string;
            title: string;
            custom_product_id: string;
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
            url: string;
            custom_product_id: string;
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
            variant_id: string;
            custom_product_id: string;
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
            value: string | null;
            custom_product_id: string;
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
    update(id: string, dto: UpdateCustomProductDto, userId: string): Promise<{
        creator: {
            display_name: string;
        };
        translations: {
            id: string;
            description: string | null;
            slug: string;
            locale: string;
            title: string;
            custom_product_id: string;
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
            url: string;
            custom_product_id: string;
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
            variant_id: string;
            custom_product_id: string;
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
            value: string | null;
            custom_product_id: string;
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
    delete(id: string, userId: string): Promise<{
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
    submit(id: string, userId: string): Promise<{
        creator: {
            display_name: string;
        };
        translations: {
            id: string;
            description: string | null;
            slug: string;
            locale: string;
            title: string;
            custom_product_id: string;
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
            url: string;
            custom_product_id: string;
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
            variant_id: string;
            custom_product_id: string;
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
            value: string | null;
            custom_product_id: string;
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
        translations: {
            id: string;
            description: string | null;
            slug: string;
            locale: string;
            title: string;
            custom_product_id: string;
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
            url: string;
            custom_product_id: string;
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
            variant_id: string;
            custom_product_id: string;
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
            value: string | null;
            custom_product_id: string;
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
    reject(id: string, userId: string, dto: RejectCustomProductDto): Promise<{
        creator: {
            display_name: string;
        };
        translations: {
            id: string;
            description: string | null;
            slug: string;
            locale: string;
            title: string;
            custom_product_id: string;
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
            url: string;
            custom_product_id: string;
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
            variant_id: string;
            custom_product_id: string;
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
            value: string | null;
            custom_product_id: string;
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
    listFaqs(id: string): Promise<({
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
    createFaq(id: string, dto: CreateCustomProductFaqDto): Promise<{
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
    updateFaq(faqId: string, dto: UpdateCustomProductFaqDto): Promise<{
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
}
export {};
