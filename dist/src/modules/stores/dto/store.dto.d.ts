export declare class CreateStoreDto {
    slug: string;
    name: string;
    description?: string;
    primary_locale?: string;
    secondary_locales?: string[];
}
export declare class UpdateStoreDto {
    slug?: string;
    name?: string;
    description?: string;
    logo_url?: string;
    favicon_url?: string;
    custom_domain?: string;
    is_active?: boolean;
}
export declare class UpdateThemeDto {
    theme_config: Record<string, any>;
}
export declare class UpdateThemeSelectionDto {
    theme_key?: string;
    theme_customizations?: Record<string, any>;
    reset_customizations?: boolean;
}
export declare class UpdateLanguageDto {
    primary_locale?: string;
    secondary_locales?: string[];
    auto_translate?: boolean;
}
