import { ShippingService } from './shipping.service';
import { CreateShippingProfileDto, CreateShippingZoneDto, CalculateShippingDto, EstimateShippingDto } from './dto/shipping.dto';
import { UserRole } from '@prisma/client';
export declare class ShippingController {
    private shippingService;
    constructor(shippingService: ShippingService);
    createProfile(userId: string, role: UserRole, dto: CreateShippingProfileDto): Promise<{
        zones: {
            id: string;
            name: string;
            profile_id: string;
            countries: string[];
            base_cost: import("@prisma/client/runtime/library").Decimal;
            per_item_cost: import("@prisma/client/runtime/library").Decimal;
            free_threshold: import("@prisma/client/runtime/library").Decimal | null;
            estimated_days_min: number;
            estimated_days_max: number;
        }[];
    } & {
        id: string;
        created_at: Date;
        name: string;
        creator_id: string | null;
        is_default: boolean;
        provider_id: string | null;
    }>;
    getProfiles(userId: string, role: UserRole): Promise<({
        zones: {
            id: string;
            name: string;
            profile_id: string;
            countries: string[];
            base_cost: import("@prisma/client/runtime/library").Decimal;
            per_item_cost: import("@prisma/client/runtime/library").Decimal;
            free_threshold: import("@prisma/client/runtime/library").Decimal | null;
            estimated_days_min: number;
            estimated_days_max: number;
        }[];
    } & {
        id: string;
        created_at: Date;
        name: string;
        creator_id: string | null;
        is_default: boolean;
        provider_id: string | null;
    })[]>;
    addZone(profileId: string, dto: CreateShippingZoneDto): Promise<{
        id: string;
        name: string;
        profile_id: string;
        countries: string[];
        base_cost: import("@prisma/client/runtime/library").Decimal;
        per_item_cost: import("@prisma/client/runtime/library").Decimal;
        free_threshold: import("@prisma/client/runtime/library").Decimal | null;
        estimated_days_min: number;
        estimated_days_max: number;
    }>;
    updateZone(id: string, dto: Partial<CreateShippingZoneDto>): Promise<{
        id: string;
        name: string;
        profile_id: string;
        countries: string[];
        base_cost: import("@prisma/client/runtime/library").Decimal;
        per_item_cost: import("@prisma/client/runtime/library").Decimal;
        free_threshold: import("@prisma/client/runtime/library").Decimal | null;
        estimated_days_min: number;
        estimated_days_max: number;
    }>;
    setDefaultProfile(id: string, userId: string, role: UserRole): Promise<{
        zones: {
            id: string;
            name: string;
            profile_id: string;
            countries: string[];
            base_cost: import("@prisma/client/runtime/library").Decimal;
            per_item_cost: import("@prisma/client/runtime/library").Decimal;
            free_threshold: import("@prisma/client/runtime/library").Decimal | null;
            estimated_days_min: number;
            estimated_days_max: number;
        }[];
    } & {
        id: string;
        created_at: Date;
        name: string;
        creator_id: string | null;
        is_default: boolean;
        provider_id: string | null;
    }>;
    deleteProfile(id: string, userId: string, role: UserRole): Promise<{
        id: string;
        created_at: Date;
        name: string;
        creator_id: string | null;
        is_default: boolean;
        provider_id: string | null;
    }>;
    deleteZone(id: string): Promise<{
        id: string;
        name: string;
        profile_id: string;
        countries: string[];
        base_cost: import("@prisma/client/runtime/library").Decimal;
        per_item_cost: import("@prisma/client/runtime/library").Decimal;
        free_threshold: import("@prisma/client/runtime/library").Decimal | null;
        estimated_days_min: number;
        estimated_days_max: number;
    }>;
    calculate(dto: CalculateShippingDto): Promise<{
        available: boolean;
        message: string;
        zone_name?: undefined;
        cost?: undefined;
        estimated_days?: undefined;
        free_shipping?: undefined;
    } | {
        available: boolean;
        zone_name: string;
        cost: number;
        estimated_days: {
            min: number;
            max: number;
        };
        free_shipping: boolean;
        message?: undefined;
    }>;
    estimate(dto: EstimateShippingDto): Promise<{
        available: boolean;
        cost: number;
        free_shipping: boolean;
        estimated_days: null;
        message?: undefined;
    } | {
        available: boolean;
        message: any;
        cost?: undefined;
        free_shipping?: undefined;
        estimated_days?: undefined;
    } | {
        available: boolean;
        cost: number;
        estimated_days: {
            min: number;
            max: number;
        };
        free_shipping: boolean;
        message?: undefined;
    }>;
}
