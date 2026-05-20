import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderStatusDto, UpdateFulfillmentDto } from './dto/order.dto';
import { UserRole } from '@prisma/client';
export declare class OrdersController {
    private ordersService;
    constructor(ordersService: OrdersService);
    create(userId: string, dto: CreateOrderDto): Promise<any>;
    findMyOrders(userId: string, page?: number, limit?: number): Promise<{
        data: ({
            items: ({
                product: ({
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
                }) | null;
                custom_product: ({
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
                }) | null;
                variant: ({
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
                } & {
                    id: string;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    product_id: string;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                }) | null;
                bundle_offer: ({
                    translations: {
                        id: string;
                        label: string | null;
                        locale: string;
                        title: string;
                        sticker_text: string | null;
                        offer_id: string;
                    }[];
                    bundle: {
                        translations: {
                            id: string;
                            name: string;
                            locale: string;
                            bundle_id: string;
                        }[];
                    } & {
                        id: string;
                        status: import("@prisma/client").$Enums.BundleStatus;
                        created_at: Date;
                        updated_at: Date;
                        creator_id: string;
                    };
                } & {
                    id: string;
                    sort_order: number;
                    quantity: number;
                    discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                    discount_value: import("@prisma/client/runtime/library").Decimal;
                    external_ref: string | null;
                    bundle_id: string;
                }) | null;
                custom_field_values: ({
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
                    custom_field_id: string;
                    file_url: string | null;
                    order_item_id: string;
                })[];
            } & {
                id: string;
                product_id: string | null;
                custom_product_id: string | null;
                variant_id: string | null;
                quantity: number;
                bundle_offer_id: string | null;
                unit_price: import("@prisma/client/runtime/library").Decimal;
                original_unit_price: import("@prisma/client/runtime/library").Decimal | null;
                total_price: import("@prisma/client/runtime/library").Decimal;
                customer_design_url: string | null;
                design_notes: string | null;
                fulfiller_type: import("@prisma/client").$Enums.FulfillerType;
                fulfiller_id: string;
                fulfillment_status: import("@prisma/client").$Enums.FulfillmentStatus;
                tracking_number: string | null;
                tracking_url: string | null;
                order_id: string;
            })[];
        } & {
            id: string;
            status: import("@prisma/client").$Enums.OrderStatus;
            created_at: Date;
            updated_at: Date;
            total: import("@prisma/client/runtime/library").Decimal;
            store_id: string | null;
            customer_id: string;
            subtotal: import("@prisma/client/runtime/library").Decimal;
            address_id: string;
            notes: string | null;
            payment_method: import("@prisma/client").$Enums.PaymentMethod;
            discount_amount: import("@prisma/client/runtime/library").Decimal;
            order_number: string;
            shipping_cost: import("@prisma/client/runtime/library").Decimal;
            currency: string;
            payment_status: string | null;
            stripe_payment_id: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findAll(userId: string, role: UserRole, page?: number, limit?: number): Promise<{
        data: ({
            customer: {
                id: string;
                created_at: Date;
                updated_at: Date;
                phone: string | null;
                user_id: string;
                first_name: string;
                last_name: string;
            };
            items: ({
                product: ({
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
                }) | null;
                custom_product: ({
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
                }) | null;
                variant: ({
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
                } & {
                    id: string;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    product_id: string;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                }) | null;
                bundle_offer: ({
                    translations: {
                        id: string;
                        label: string | null;
                        locale: string;
                        title: string;
                        sticker_text: string | null;
                        offer_id: string;
                    }[];
                    bundle: {
                        translations: {
                            id: string;
                            name: string;
                            locale: string;
                            bundle_id: string;
                        }[];
                    } & {
                        id: string;
                        status: import("@prisma/client").$Enums.BundleStatus;
                        created_at: Date;
                        updated_at: Date;
                        creator_id: string;
                    };
                } & {
                    id: string;
                    sort_order: number;
                    quantity: number;
                    discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                    discount_value: import("@prisma/client/runtime/library").Decimal;
                    external_ref: string | null;
                    bundle_id: string;
                }) | null;
                custom_field_values: ({
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
                    custom_field_id: string;
                    file_url: string | null;
                    order_item_id: string;
                })[];
            } & {
                id: string;
                product_id: string | null;
                custom_product_id: string | null;
                variant_id: string | null;
                quantity: number;
                bundle_offer_id: string | null;
                unit_price: import("@prisma/client/runtime/library").Decimal;
                original_unit_price: import("@prisma/client/runtime/library").Decimal | null;
                total_price: import("@prisma/client/runtime/library").Decimal;
                customer_design_url: string | null;
                design_notes: string | null;
                fulfiller_type: import("@prisma/client").$Enums.FulfillerType;
                fulfiller_id: string;
                fulfillment_status: import("@prisma/client").$Enums.FulfillmentStatus;
                tracking_number: string | null;
                tracking_url: string | null;
                order_id: string;
            })[];
        } & {
            id: string;
            status: import("@prisma/client").$Enums.OrderStatus;
            created_at: Date;
            updated_at: Date;
            total: import("@prisma/client/runtime/library").Decimal;
            store_id: string | null;
            customer_id: string;
            subtotal: import("@prisma/client/runtime/library").Decimal;
            address_id: string;
            notes: string | null;
            payment_method: import("@prisma/client").$Enums.PaymentMethod;
            discount_amount: import("@prisma/client/runtime/library").Decimal;
            order_number: string;
            shipping_cost: import("@prisma/client/runtime/library").Decimal;
            currency: string;
            payment_status: string | null;
            stripe_payment_id: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findByFulfiller(fulfillerId: string, page?: number, limit?: number): Promise<{
        data: ({
            customer: {
                id: string;
                created_at: Date;
                updated_at: Date;
                phone: string | null;
                user_id: string;
                first_name: string;
                last_name: string;
            };
            address: {
                id: string;
                created_at: Date;
                phone: string | null;
                label: string | null;
                full_name: string;
                line1: string;
                line2: string | null;
                city: string;
                state: string | null;
                postal_code: string;
                country_code: string;
                is_default: boolean;
                customer_id: string;
            };
            items: ({
                product: ({
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
                }) | null;
                custom_product: ({
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
                }) | null;
                variant: ({
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
                } & {
                    id: string;
                    is_active: boolean;
                    options: import("@prisma/client/runtime/library").JsonValue;
                    compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                    sku: string | null;
                    stock_quantity: number | null;
                    product_id: string;
                    price_adjustment: import("@prisma/client/runtime/library").Decimal;
                }) | null;
                bundle_offer: ({
                    translations: {
                        id: string;
                        label: string | null;
                        locale: string;
                        title: string;
                        sticker_text: string | null;
                        offer_id: string;
                    }[];
                    bundle: {
                        translations: {
                            id: string;
                            name: string;
                            locale: string;
                            bundle_id: string;
                        }[];
                    } & {
                        id: string;
                        status: import("@prisma/client").$Enums.BundleStatus;
                        created_at: Date;
                        updated_at: Date;
                        creator_id: string;
                    };
                } & {
                    id: string;
                    sort_order: number;
                    quantity: number;
                    discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                    discount_value: import("@prisma/client/runtime/library").Decimal;
                    external_ref: string | null;
                    bundle_id: string;
                }) | null;
                custom_field_values: ({
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
                    custom_field_id: string;
                    file_url: string | null;
                    order_item_id: string;
                })[];
            } & {
                id: string;
                product_id: string | null;
                custom_product_id: string | null;
                variant_id: string | null;
                quantity: number;
                bundle_offer_id: string | null;
                unit_price: import("@prisma/client/runtime/library").Decimal;
                original_unit_price: import("@prisma/client/runtime/library").Decimal | null;
                total_price: import("@prisma/client/runtime/library").Decimal;
                customer_design_url: string | null;
                design_notes: string | null;
                fulfiller_type: import("@prisma/client").$Enums.FulfillerType;
                fulfiller_id: string;
                fulfillment_status: import("@prisma/client").$Enums.FulfillmentStatus;
                tracking_number: string | null;
                tracking_url: string | null;
                order_id: string;
            })[];
            commission: {
                id: string;
                status: import("@prisma/client").$Enums.CommissionStatus;
                created_at: Date;
                order_id: string;
                currency: string;
                provider_amount: import("@prisma/client/runtime/library").Decimal;
                platform_amount: import("@prisma/client/runtime/library").Decimal;
                creator_amount: import("@prisma/client/runtime/library").Decimal;
            } | null;
        } & {
            id: string;
            status: import("@prisma/client").$Enums.OrderStatus;
            created_at: Date;
            updated_at: Date;
            total: import("@prisma/client/runtime/library").Decimal;
            store_id: string | null;
            customer_id: string;
            subtotal: import("@prisma/client/runtime/library").Decimal;
            address_id: string;
            notes: string | null;
            payment_method: import("@prisma/client").$Enums.PaymentMethod;
            discount_amount: import("@prisma/client/runtime/library").Decimal;
            order_number: string;
            shipping_cost: import("@prisma/client/runtime/library").Decimal;
            currency: string;
            payment_status: string | null;
            stripe_payment_id: string | null;
        })[];
        meta: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    findById(id: string): Promise<{
        customer: {
            id: string;
            created_at: Date;
            updated_at: Date;
            phone: string | null;
            user_id: string;
            first_name: string;
            last_name: string;
        };
        address: {
            id: string;
            created_at: Date;
            phone: string | null;
            label: string | null;
            full_name: string;
            line1: string;
            line2: string | null;
            city: string;
            state: string | null;
            postal_code: string;
            country_code: string;
            is_default: boolean;
            customer_id: string;
        };
        items: ({
            product: ({
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
            }) | null;
            custom_product: ({
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
            }) | null;
            variant: ({
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
            } & {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            }) | null;
            bundle_offer: ({
                translations: {
                    id: string;
                    label: string | null;
                    locale: string;
                    title: string;
                    sticker_text: string | null;
                    offer_id: string;
                }[];
                bundle: {
                    translations: {
                        id: string;
                        name: string;
                        locale: string;
                        bundle_id: string;
                    }[];
                } & {
                    id: string;
                    status: import("@prisma/client").$Enums.BundleStatus;
                    created_at: Date;
                    updated_at: Date;
                    creator_id: string;
                };
            } & {
                id: string;
                sort_order: number;
                quantity: number;
                discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                discount_value: import("@prisma/client/runtime/library").Decimal;
                external_ref: string | null;
                bundle_id: string;
            }) | null;
            custom_field_values: ({
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
                custom_field_id: string;
                file_url: string | null;
                order_item_id: string;
            })[];
        } & {
            id: string;
            product_id: string | null;
            custom_product_id: string | null;
            variant_id: string | null;
            quantity: number;
            bundle_offer_id: string | null;
            unit_price: import("@prisma/client/runtime/library").Decimal;
            original_unit_price: import("@prisma/client/runtime/library").Decimal | null;
            total_price: import("@prisma/client/runtime/library").Decimal;
            customer_design_url: string | null;
            design_notes: string | null;
            fulfiller_type: import("@prisma/client").$Enums.FulfillerType;
            fulfiller_id: string;
            fulfillment_status: import("@prisma/client").$Enums.FulfillmentStatus;
            tracking_number: string | null;
            tracking_url: string | null;
            order_id: string;
        })[];
        commission: {
            id: string;
            status: import("@prisma/client").$Enums.CommissionStatus;
            created_at: Date;
            order_id: string;
            currency: string;
            provider_amount: import("@prisma/client/runtime/library").Decimal;
            platform_amount: import("@prisma/client/runtime/library").Decimal;
            creator_amount: import("@prisma/client/runtime/library").Decimal;
        } | null;
        timeline: {
            id: string;
            status: string;
            created_at: Date;
            order_id: string;
            note: string | null;
            actor: string | null;
        }[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.OrderStatus;
        created_at: Date;
        updated_at: Date;
        total: import("@prisma/client/runtime/library").Decimal;
        store_id: string | null;
        customer_id: string;
        subtotal: import("@prisma/client/runtime/library").Decimal;
        address_id: string;
        notes: string | null;
        payment_method: import("@prisma/client").$Enums.PaymentMethod;
        discount_amount: import("@prisma/client/runtime/library").Decimal;
        order_number: string;
        shipping_cost: import("@prisma/client/runtime/library").Decimal;
        currency: string;
        payment_status: string | null;
        stripe_payment_id: string | null;
    }>;
    updateStatus(id: string, dto: UpdateOrderStatusDto, userId: string, userRole: UserRole): Promise<{
        customer: {
            id: string;
            created_at: Date;
            updated_at: Date;
            phone: string | null;
            user_id: string;
            first_name: string;
            last_name: string;
        };
        address: {
            id: string;
            created_at: Date;
            phone: string | null;
            label: string | null;
            full_name: string;
            line1: string;
            line2: string | null;
            city: string;
            state: string | null;
            postal_code: string;
            country_code: string;
            is_default: boolean;
            customer_id: string;
        };
        items: ({
            product: ({
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
            }) | null;
            custom_product: ({
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
            }) | null;
            variant: ({
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
            } & {
                id: string;
                is_active: boolean;
                options: import("@prisma/client/runtime/library").JsonValue;
                compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
                sku: string | null;
                stock_quantity: number | null;
                product_id: string;
                price_adjustment: import("@prisma/client/runtime/library").Decimal;
            }) | null;
            bundle_offer: ({
                translations: {
                    id: string;
                    label: string | null;
                    locale: string;
                    title: string;
                    sticker_text: string | null;
                    offer_id: string;
                }[];
                bundle: {
                    translations: {
                        id: string;
                        name: string;
                        locale: string;
                        bundle_id: string;
                    }[];
                } & {
                    id: string;
                    status: import("@prisma/client").$Enums.BundleStatus;
                    created_at: Date;
                    updated_at: Date;
                    creator_id: string;
                };
            } & {
                id: string;
                sort_order: number;
                quantity: number;
                discount_type: import("@prisma/client").$Enums.BundleDiscountType;
                discount_value: import("@prisma/client/runtime/library").Decimal;
                external_ref: string | null;
                bundle_id: string;
            }) | null;
            custom_field_values: ({
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
                custom_field_id: string;
                file_url: string | null;
                order_item_id: string;
            })[];
        } & {
            id: string;
            product_id: string | null;
            custom_product_id: string | null;
            variant_id: string | null;
            quantity: number;
            bundle_offer_id: string | null;
            unit_price: import("@prisma/client/runtime/library").Decimal;
            original_unit_price: import("@prisma/client/runtime/library").Decimal | null;
            total_price: import("@prisma/client/runtime/library").Decimal;
            customer_design_url: string | null;
            design_notes: string | null;
            fulfiller_type: import("@prisma/client").$Enums.FulfillerType;
            fulfiller_id: string;
            fulfillment_status: import("@prisma/client").$Enums.FulfillmentStatus;
            tracking_number: string | null;
            tracking_url: string | null;
            order_id: string;
        })[];
        commission: {
            id: string;
            status: import("@prisma/client").$Enums.CommissionStatus;
            created_at: Date;
            order_id: string;
            currency: string;
            provider_amount: import("@prisma/client/runtime/library").Decimal;
            platform_amount: import("@prisma/client/runtime/library").Decimal;
            creator_amount: import("@prisma/client/runtime/library").Decimal;
        } | null;
        timeline: {
            id: string;
            status: string;
            created_at: Date;
            order_id: string;
            note: string | null;
            actor: string | null;
        }[];
    } & {
        id: string;
        status: import("@prisma/client").$Enums.OrderStatus;
        created_at: Date;
        updated_at: Date;
        total: import("@prisma/client/runtime/library").Decimal;
        store_id: string | null;
        customer_id: string;
        subtotal: import("@prisma/client/runtime/library").Decimal;
        address_id: string;
        notes: string | null;
        payment_method: import("@prisma/client").$Enums.PaymentMethod;
        discount_amount: import("@prisma/client/runtime/library").Decimal;
        order_number: string;
        shipping_cost: import("@prisma/client/runtime/library").Decimal;
        currency: string;
        payment_status: string | null;
        stripe_payment_id: string | null;
    }>;
    updateFulfillment(orderId: string, itemId: string, dto: UpdateFulfillmentDto, userId: string, userRole: UserRole): Promise<{
        id: string;
        product_id: string | null;
        custom_product_id: string | null;
        variant_id: string | null;
        quantity: number;
        bundle_offer_id: string | null;
        unit_price: import("@prisma/client/runtime/library").Decimal;
        original_unit_price: import("@prisma/client/runtime/library").Decimal | null;
        total_price: import("@prisma/client/runtime/library").Decimal;
        customer_design_url: string | null;
        design_notes: string | null;
        fulfiller_type: import("@prisma/client").$Enums.FulfillerType;
        fulfiller_id: string;
        fulfillment_status: import("@prisma/client").$Enums.FulfillmentStatus;
        tracking_number: string | null;
        tracking_url: string | null;
        order_id: string;
    }>;
}
