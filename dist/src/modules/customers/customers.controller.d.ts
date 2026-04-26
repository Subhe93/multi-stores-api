import { CustomersService } from './customers.service';
import { CreateCustomerDto, UpdateCustomerDto, CreateAddressDto } from './dto/create-customer.dto';
export declare class CustomersController {
    private customersService;
    constructor(customersService: CustomersService);
    create(userId: string, dto: CreateCustomerDto): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        phone: string | null;
        user_id: string;
        first_name: string;
        last_name: string;
    }>;
    getMyProfile(userId: string): Promise<({
        addresses: {
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
        }[];
    } & {
        id: string;
        created_at: Date;
        updated_at: Date;
        phone: string | null;
        user_id: string;
        first_name: string;
        last_name: string;
    }) | null>;
    updateMyProfile(userId: string, dto: UpdateCustomerDto): Promise<{
        id: string;
        created_at: Date;
        updated_at: Date;
        phone: string | null;
        user_id: string;
        first_name: string;
        last_name: string;
    }>;
    addAddress(userId: string, dto: CreateAddressDto): Promise<{
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
    }>;
    getAddresses(userId: string): Promise<{
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
    }[]>;
    deleteAddress(userId: string, addressId: string): Promise<{
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
    }>;
}
