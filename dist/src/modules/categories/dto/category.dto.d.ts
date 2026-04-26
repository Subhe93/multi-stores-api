export declare class CreateCategoryDto {
    slug: string;
    parent_id?: string;
    icon?: string;
    sort_order?: number;
    translations: CategoryTranslationDto[];
}
export declare class CategoryTranslationDto {
    locale: string;
    name: string;
    description?: string;
}
export declare class UpdateCategoryDto {
    slug?: string;
    parent_id?: string;
    icon?: string;
    sort_order?: number;
    is_active?: boolean;
    translations?: CategoryTranslationDto[];
}
export declare class LinkAttributesDto {
    template_ids: string[];
}
