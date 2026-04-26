export declare class CreateShippingZoneDto {
    name: string;
    countries: string[];
    base_cost: number;
    per_item_cost?: number;
    free_threshold?: number;
    estimated_days_min: number;
    estimated_days_max: number;
}
export declare class CreateShippingProfileDto {
    name: string;
    is_default?: boolean;
    zones?: CreateShippingZoneDto[];
}
export declare class EstimateShippingDto {
    product_ids: string[];
    country_code: string;
    item_count: number;
    subtotal: number;
}
export declare class CalculateShippingDto {
    profile_id: string;
    country_code: string;
    item_count: number;
    subtotal: number;
}
