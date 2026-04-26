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
        product: {
            translations: {
                id: string;
                product_id: string;
                locale: string;
                title: string;
                description: string;
                slug: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                product_id: string;
                variant_id: string | null;
                url: string;
                sort_order: number;
                is_featured: boolean;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
            custom_fields: ({
                translations: {
                    id: string;
                    locale: string;
                    placeholder: string | null;
                    field_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        creator: {
            display_name: string;
        };
        mockup_images: {
            id: string;
            url: string;
            sort_order: number;
            custom_product_id: string;
        }[];
        translations: {
            id: string;
            locale: string;
            title: string;
            description: string | null;
            slug: string;
            custom_product_id: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            };
        } & {
            id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
            variant_id: string;
            custom_product_id: string;
        })[];
        field_values: ({
            custom_field: {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
            };
        } & {
            id: string;
            value: string | null;
            file_url: string | null;
            custom_field_id: string;
            custom_product_id: string;
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
    } & {
        id: string;
        import_mode: import("@prisma/client").$Enums.ImportMode;
        pricing_type: import("@prisma/client").$Enums.PricingType;
        final_price: import("@prisma/client/runtime/library").Decimal;
        margin_amount: import("@prisma/client/runtime/library").Decimal | null;
        status: import("@prisma/client").$Enums.ProductStatus;
        rejection_reason: string | null;
        submitted_at: Date | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        created_at: Date;
        updated_at: Date;
        product_id: string;
        creator_id: string;
    }>;
    findMyCustomProducts(userId: string, page?: number, limit?: number): Promise<{
        data: ({
            product: {
                translations: {
                    id: string;
                    product_id: string;
                    locale: string;
                    title: string;
                    description: string;
                    slug: string;
                    meta_title: string | null;
                    meta_desc: string | null;
                }[];
                images: {
                    id: string;
                    product_id: string;
                    variant_id: string | null;
                    url: string;
                    sort_order: number;
                    is_featured: boolean;
                    alt_text: string | null;
                }[];
                variants: {
                    id: string;
                    product_id: string;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                }[];
                custom_fields: ({
                    translations: {
                        id: string;
                        locale: string;
                        placeholder: string | null;
                        field_id: string;
                        label: string;
                        option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                    }[];
                } & {
                    id: string;
                    product_id: string;
                    name: string;
                    sort_order: number;
                    options: import("@prisma/client/runtime/library").JsonValue | null;
                    type: import("@prisma/client").$Enums.CustomFieldType;
                    is_required: boolean;
                    placeholder: string | null;
                    validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
            creator: {
                display_name: string;
            };
            mockup_images: {
                id: string;
                url: string;
                sort_order: number;
                custom_product_id: string;
            }[];
            translations: {
                id: string;
                locale: string;
                title: string;
                description: string | null;
                slug: string;
                custom_product_id: string;
            }[];
            selected_variants: ({
                variant: {
                    id: string;
                    product_id: string;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                };
            } & {
                id: string;
                custom_price: import("@prisma/client/runtime/library").Decimal | null;
                variant_id: string;
                custom_product_id: string;
            })[];
            field_values: ({
                custom_field: {
                    id: string;
                    product_id: string;
                    name: string;
                    sort_order: number;
                    options: import("@prisma/client/runtime/library").JsonValue | null;
                    type: import("@prisma/client").$Enums.CustomFieldType;
                    is_required: boolean;
                    placeholder: string | null;
                    validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                    linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
                };
            } & {
                id: string;
                value: string | null;
                file_url: string | null;
                custom_field_id: string;
                custom_product_id: string;
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
                created_at: Date;
                sort_order: number;
                custom_product_id: string;
            })[];
        } & {
            id: string;
            import_mode: import("@prisma/client").$Enums.ImportMode;
            pricing_type: import("@prisma/client").$Enums.PricingType;
            final_price: import("@prisma/client/runtime/library").Decimal;
            margin_amount: import("@prisma/client/runtime/library").Decimal | null;
            status: import("@prisma/client").$Enums.ProductStatus;
            rejection_reason: string | null;
            submitted_at: Date | null;
            reviewed_at: Date | null;
            reviewed_by: string | null;
            created_at: Date;
            updated_at: Date;
            product_id: string;
            creator_id: string;
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
            product: {
                translations: {
                    id: string;
                    product_id: string;
                    locale: string;
                    title: string;
                    description: string;
                    slug: string;
                    meta_title: string | null;
                    meta_desc: string | null;
                }[];
                images: {
                    id: string;
                    product_id: string;
                    variant_id: string | null;
                    url: string;
                    sort_order: number;
                    is_featured: boolean;
                    alt_text: string | null;
                }[];
                variants: {
                    id: string;
                    product_id: string;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                }[];
                custom_fields: ({
                    translations: {
                        id: string;
                        locale: string;
                        placeholder: string | null;
                        field_id: string;
                        label: string;
                        option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                    }[];
                } & {
                    id: string;
                    product_id: string;
                    name: string;
                    sort_order: number;
                    options: import("@prisma/client/runtime/library").JsonValue | null;
                    type: import("@prisma/client").$Enums.CustomFieldType;
                    is_required: boolean;
                    placeholder: string | null;
                    validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
            creator: {
                display_name: string;
            };
            mockup_images: {
                id: string;
                url: string;
                sort_order: number;
                custom_product_id: string;
            }[];
            translations: {
                id: string;
                locale: string;
                title: string;
                description: string | null;
                slug: string;
                custom_product_id: string;
            }[];
            selected_variants: ({
                variant: {
                    id: string;
                    product_id: string;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                };
            } & {
                id: string;
                custom_price: import("@prisma/client/runtime/library").Decimal | null;
                variant_id: string;
                custom_product_id: string;
            })[];
            field_values: ({
                custom_field: {
                    id: string;
                    product_id: string;
                    name: string;
                    sort_order: number;
                    options: import("@prisma/client/runtime/library").JsonValue | null;
                    type: import("@prisma/client").$Enums.CustomFieldType;
                    is_required: boolean;
                    placeholder: string | null;
                    validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                    linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
                };
            } & {
                id: string;
                value: string | null;
                file_url: string | null;
                custom_field_id: string;
                custom_product_id: string;
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
                created_at: Date;
                sort_order: number;
                custom_product_id: string;
            })[];
        } & {
            id: string;
            import_mode: import("@prisma/client").$Enums.ImportMode;
            pricing_type: import("@prisma/client").$Enums.PricingType;
            final_price: import("@prisma/client/runtime/library").Decimal;
            margin_amount: import("@prisma/client/runtime/library").Decimal | null;
            status: import("@prisma/client").$Enums.ProductStatus;
            rejection_reason: string | null;
            submitted_at: Date | null;
            reviewed_at: Date | null;
            reviewed_by: string | null;
            created_at: Date;
            updated_at: Date;
            product_id: string;
            creator_id: string;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findById(id: string): Promise<{
        product: {
            translations: {
                id: string;
                product_id: string;
                locale: string;
                title: string;
                description: string;
                slug: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                product_id: string;
                variant_id: string | null;
                url: string;
                sort_order: number;
                is_featured: boolean;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
            custom_fields: ({
                translations: {
                    id: string;
                    locale: string;
                    placeholder: string | null;
                    field_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        creator: {
            display_name: string;
        };
        mockup_images: {
            id: string;
            url: string;
            sort_order: number;
            custom_product_id: string;
        }[];
        translations: {
            id: string;
            locale: string;
            title: string;
            description: string | null;
            slug: string;
            custom_product_id: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            };
        } & {
            id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
            variant_id: string;
            custom_product_id: string;
        })[];
        field_values: ({
            custom_field: {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
            };
        } & {
            id: string;
            value: string | null;
            file_url: string | null;
            custom_field_id: string;
            custom_product_id: string;
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
    } & {
        id: string;
        import_mode: import("@prisma/client").$Enums.ImportMode;
        pricing_type: import("@prisma/client").$Enums.PricingType;
        final_price: import("@prisma/client/runtime/library").Decimal;
        margin_amount: import("@prisma/client/runtime/library").Decimal | null;
        status: import("@prisma/client").$Enums.ProductStatus;
        rejection_reason: string | null;
        submitted_at: Date | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        created_at: Date;
        updated_at: Date;
        product_id: string;
        creator_id: string;
    }>;
    update(id: string, dto: UpdateCustomProductDto, userId: string): Promise<{
        product: {
            translations: {
                id: string;
                product_id: string;
                locale: string;
                title: string;
                description: string;
                slug: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                product_id: string;
                variant_id: string | null;
                url: string;
                sort_order: number;
                is_featured: boolean;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
            custom_fields: ({
                translations: {
                    id: string;
                    locale: string;
                    placeholder: string | null;
                    field_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        creator: {
            display_name: string;
        };
        mockup_images: {
            id: string;
            url: string;
            sort_order: number;
            custom_product_id: string;
        }[];
        translations: {
            id: string;
            locale: string;
            title: string;
            description: string | null;
            slug: string;
            custom_product_id: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            };
        } & {
            id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
            variant_id: string;
            custom_product_id: string;
        })[];
        field_values: ({
            custom_field: {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
            };
        } & {
            id: string;
            value: string | null;
            file_url: string | null;
            custom_field_id: string;
            custom_product_id: string;
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
    } & {
        id: string;
        import_mode: import("@prisma/client").$Enums.ImportMode;
        pricing_type: import("@prisma/client").$Enums.PricingType;
        final_price: import("@prisma/client/runtime/library").Decimal;
        margin_amount: import("@prisma/client/runtime/library").Decimal | null;
        status: import("@prisma/client").$Enums.ProductStatus;
        rejection_reason: string | null;
        submitted_at: Date | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        created_at: Date;
        updated_at: Date;
        product_id: string;
        creator_id: string;
    }>;
    delete(id: string, userId: string): Promise<{
        id: string;
        import_mode: import("@prisma/client").$Enums.ImportMode;
        pricing_type: import("@prisma/client").$Enums.PricingType;
        final_price: import("@prisma/client/runtime/library").Decimal;
        margin_amount: import("@prisma/client/runtime/library").Decimal | null;
        status: import("@prisma/client").$Enums.ProductStatus;
        rejection_reason: string | null;
        submitted_at: Date | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        created_at: Date;
        updated_at: Date;
        product_id: string;
        creator_id: string;
    }>;
    submit(id: string, userId: string): Promise<{
        product: {
            translations: {
                id: string;
                product_id: string;
                locale: string;
                title: string;
                description: string;
                slug: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                product_id: string;
                variant_id: string | null;
                url: string;
                sort_order: number;
                is_featured: boolean;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
            custom_fields: ({
                translations: {
                    id: string;
                    locale: string;
                    placeholder: string | null;
                    field_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        creator: {
            display_name: string;
        };
        mockup_images: {
            id: string;
            url: string;
            sort_order: number;
            custom_product_id: string;
        }[];
        translations: {
            id: string;
            locale: string;
            title: string;
            description: string | null;
            slug: string;
            custom_product_id: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            };
        } & {
            id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
            variant_id: string;
            custom_product_id: string;
        })[];
        field_values: ({
            custom_field: {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
            };
        } & {
            id: string;
            value: string | null;
            file_url: string | null;
            custom_field_id: string;
            custom_product_id: string;
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
    } & {
        id: string;
        import_mode: import("@prisma/client").$Enums.ImportMode;
        pricing_type: import("@prisma/client").$Enums.PricingType;
        final_price: import("@prisma/client/runtime/library").Decimal;
        margin_amount: import("@prisma/client/runtime/library").Decimal | null;
        status: import("@prisma/client").$Enums.ProductStatus;
        rejection_reason: string | null;
        submitted_at: Date | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        created_at: Date;
        updated_at: Date;
        product_id: string;
        creator_id: string;
    }>;
    approve(id: string, userId: string): Promise<{
        product: {
            translations: {
                id: string;
                product_id: string;
                locale: string;
                title: string;
                description: string;
                slug: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                product_id: string;
                variant_id: string | null;
                url: string;
                sort_order: number;
                is_featured: boolean;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
            custom_fields: ({
                translations: {
                    id: string;
                    locale: string;
                    placeholder: string | null;
                    field_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        creator: {
            display_name: string;
        };
        mockup_images: {
            id: string;
            url: string;
            sort_order: number;
            custom_product_id: string;
        }[];
        translations: {
            id: string;
            locale: string;
            title: string;
            description: string | null;
            slug: string;
            custom_product_id: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            };
        } & {
            id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
            variant_id: string;
            custom_product_id: string;
        })[];
        field_values: ({
            custom_field: {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
            };
        } & {
            id: string;
            value: string | null;
            file_url: string | null;
            custom_field_id: string;
            custom_product_id: string;
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
    } & {
        id: string;
        import_mode: import("@prisma/client").$Enums.ImportMode;
        pricing_type: import("@prisma/client").$Enums.PricingType;
        final_price: import("@prisma/client/runtime/library").Decimal;
        margin_amount: import("@prisma/client/runtime/library").Decimal | null;
        status: import("@prisma/client").$Enums.ProductStatus;
        rejection_reason: string | null;
        submitted_at: Date | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        created_at: Date;
        updated_at: Date;
        product_id: string;
        creator_id: string;
    }>;
    reject(id: string, userId: string, dto: RejectCustomProductDto): Promise<{
        product: {
            translations: {
                id: string;
                product_id: string;
                locale: string;
                title: string;
                description: string;
                slug: string;
                meta_title: string | null;
                meta_desc: string | null;
            }[];
            images: {
                id: string;
                product_id: string;
                variant_id: string | null;
                url: string;
                sort_order: number;
                is_featured: boolean;
                alt_text: string | null;
            }[];
            variants: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            }[];
            custom_fields: ({
                translations: {
                    id: string;
                    locale: string;
                    placeholder: string | null;
                    field_id: string;
                    label: string;
                    option_labels: import("@prisma/client/runtime/library").JsonValue | null;
                }[];
            } & {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
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
        creator: {
            display_name: string;
        };
        mockup_images: {
            id: string;
            url: string;
            sort_order: number;
            custom_product_id: string;
        }[];
        translations: {
            id: string;
            locale: string;
            title: string;
            description: string | null;
            slug: string;
            custom_product_id: string;
        }[];
        selected_variants: ({
            variant: {
                id: string;
                product_id: string;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
            };
        } & {
            id: string;
            custom_price: import("@prisma/client/runtime/library").Decimal | null;
            variant_id: string;
            custom_product_id: string;
        })[];
        field_values: ({
            custom_field: {
                id: string;
                product_id: string;
                name: string;
                sort_order: number;
                options: import("@prisma/client/runtime/library").JsonValue | null;
                type: import("@prisma/client").$Enums.CustomFieldType;
                is_required: boolean;
                placeholder: string | null;
                validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
                linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
            };
        } & {
            id: string;
            value: string | null;
            file_url: string | null;
            custom_field_id: string;
            custom_product_id: string;
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
            created_at: Date;
            sort_order: number;
            custom_product_id: string;
        })[];
    } & {
        id: string;
        import_mode: import("@prisma/client").$Enums.ImportMode;
        pricing_type: import("@prisma/client").$Enums.PricingType;
        final_price: import("@prisma/client/runtime/library").Decimal;
        margin_amount: import("@prisma/client/runtime/library").Decimal | null;
        status: import("@prisma/client").$Enums.ProductStatus;
        rejection_reason: string | null;
        submitted_at: Date | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
        created_at: Date;
        updated_at: Date;
        product_id: string;
        creator_id: string;
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
