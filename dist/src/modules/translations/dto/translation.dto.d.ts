export declare enum TranslatableEntity {
    PRODUCT = "product",
    CATEGORY = "category",
    CUSTOM_PRODUCT = "custom_product",
    PROMOTION = "promotion",
    STATIC_PAGE = "static_page",
    CUSTOM_FIELD = "custom_field"
}
export declare class AutoTranslateDto {
    entity_type: TranslatableEntity;
    entity_id: string;
    source_locale: string;
    target_locale: string;
}
export declare class BulkTranslateDto {
    store_id: string;
    target_locale: string;
    source_locale?: string;
    entity_types?: string[];
}
