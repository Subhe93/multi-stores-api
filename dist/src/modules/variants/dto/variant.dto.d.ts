export declare class CreateVariantDto {
    sku?: string;
    price_adjustment?: number;
    compare_at_price?: number;
    stock_quantity?: number;
    options: Record<string, string>;
}
export declare class UpdateVariantDto {
    sku?: string;
    price_adjustment?: number;
    compare_at_price?: number;
    stock_quantity?: number;
    is_active?: boolean;
    options?: Record<string, string>;
}
