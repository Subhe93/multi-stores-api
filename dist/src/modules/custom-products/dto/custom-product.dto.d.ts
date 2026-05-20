import { ProductStatus, ImportMode, PricingType } from '@prisma/client';
export declare class CustomProductTranslationDto {
    locale: string;
    title: string;
    description?: string;
    slug: string;
}
export declare class CustomProductVariantDto {
    variant_id: string;
    custom_price?: number;
}
export declare class CustomProductFieldValueDto {
    custom_field_id: string;
    value?: string;
    file_url?: string;
}
export declare class CreateCustomProductDto {
    product_id: string;
    import_mode: ImportMode;
    pricing_type: PricingType;
    final_price?: number;
    margin_amount?: number;
    selected_variants?: CustomProductVariantDto[];
    field_values?: CustomProductFieldValueDto[];
    mockup_image_urls?: string[];
    translations: CustomProductTranslationDto[];
    bundle_ids?: string[];
    creator_category_ids?: string[];
}
export declare class UpdateCustomProductDto {
    pricing_type?: PricingType;
    final_price?: number;
    margin_amount?: number;
    status?: ProductStatus;
    selected_variants?: CustomProductVariantDto[];
    field_values?: CustomProductFieldValueDto[];
    mockup_image_urls?: string[];
    translations?: CustomProductTranslationDto[];
    bundle_ids?: string[];
    creator_category_ids?: string[];
}
