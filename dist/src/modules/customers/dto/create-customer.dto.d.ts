export declare class CreateCustomerDto {
    first_name: string;
    last_name: string;
    phone?: string;
}
export declare class UpdateCustomerDto {
    first_name?: string;
    last_name?: string;
    phone?: string;
}
export declare class CreateAddressDto {
    label?: string;
    full_name: string;
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postal_code: string;
    country_code: string;
    phone?: string;
}
