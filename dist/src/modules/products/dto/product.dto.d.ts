import { ProductType, CustomizationType, ProductStatus } from '@prisma/client';
export declare class ProductTranslationDto {
    locale: string;
    title: string;
    description: string;
    slug: string;
    meta_title?: string;
    meta_desc?: string;
}
export declare class ProductAttributeValueDto {
    template_id: string;
    value: any;
}
export declare class CreateProductDto {
    category_id: string;
    product_type: ProductType;
    customization_type?: CustomizationType;
    base_price: number;
    compare_at_price?: number;
    cost_price?: number;
    sku?: string;
    track_inventory?: boolean;
    stock_quantity?: number;
    weight?: number;
    weight_unit?: string;
    variant_option_config?: any;
    shipping_profile_id?: string;
    translations: ProductTranslationDto[];
    attributes?: ProductAttributeValueDto[];
    status?: ProductStatus;
    tags?: string[];
}
export declare class UpdateProductDto {
    category_id?: string;
    product_type?: ProductType;
    customization_type?: CustomizationType;
    base_price?: number;
    compare_at_price?: number;
    cost_price?: number;
    sku?: string;
    track_inventory?: boolean;
    stock_quantity?: number;
    weight?: number;
    weight_unit?: string;
    variant_option_config?: any;
    shipping_profile_id?: string;
    status?: ProductStatus;
    is_featured?: boolean;
    translations?: ProductTranslationDto[];
    attributes?: ProductAttributeValueDto[];
    tags?: string[];
}
