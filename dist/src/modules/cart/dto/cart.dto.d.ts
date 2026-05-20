export declare class AddCartItemDto {
    product_id?: string;
    variant_id?: string;
    custom_product_id?: string;
    bundle_offer_id?: string;
    quantity: number;
    custom_fields?: any;
}
export declare class UpdateCartItemDto {
    quantity?: number;
    bundle_offer_id?: string | null;
}
