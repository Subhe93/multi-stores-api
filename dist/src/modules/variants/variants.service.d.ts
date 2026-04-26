import { PrismaService } from '../../prisma/prisma.service';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
export declare class VariantsService {
    private prisma;
    constructor(prisma: PrismaService);
    create(productId: string, dto: CreateVariantDto): Promise<{
        images: {
            id: string;
            sort_order: number;
            is_featured: boolean;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
    } & {
        id: string;
        is_active: boolean;
        options: import("@prisma/client/runtime/library").JsonValue;
        compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
        sku: string | null;
        stock_quantity: number | null;
        product_id: string;
        price_adjustment: import("@prisma/client/runtime/library").Decimal;
    }>;
    findByProduct(productId: string): Promise<({
        images: {
            id: string;
            sort_order: number;
            is_featured: boolean;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
    } & {
        id: string;
        is_active: boolean;
        options: import("@prisma/client/runtime/library").JsonValue;
        compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
        sku: string | null;
        stock_quantity: number | null;
        product_id: string;
        price_adjustment: import("@prisma/client/runtime/library").Decimal;
    })[]>;
    findById(id: string): Promise<{
        images: {
            id: string;
            sort_order: number;
            is_featured: boolean;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
    } & {
        id: string;
        is_active: boolean;
        options: import("@prisma/client/runtime/library").JsonValue;
        compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
        sku: string | null;
        stock_quantity: number | null;
        product_id: string;
        price_adjustment: import("@prisma/client/runtime/library").Decimal;
    }>;
    update(id: string, dto: UpdateVariantDto): Promise<{
        images: {
            id: string;
            sort_order: number;
            is_featured: boolean;
            product_id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
        }[];
    } & {
        id: string;
        is_active: boolean;
        options: import("@prisma/client/runtime/library").JsonValue;
        compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
        sku: string | null;
        stock_quantity: number | null;
        product_id: string;
        price_adjustment: import("@prisma/client/runtime/library").Decimal;
    }>;
    delete(id: string): Promise<{
        id: string;
        is_active: boolean;
        options: import("@prisma/client/runtime/library").JsonValue;
        compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
        sku: string | null;
        stock_quantity: number | null;
        product_id: string;
        price_adjustment: import("@prisma/client/runtime/library").Decimal;
    }>;
    updateStock(id: string, quantity: number): Promise<{
        id: string;
        is_active: boolean;
        options: import("@prisma/client/runtime/library").JsonValue;
        compare_at_price: import("@prisma/client/runtime/library").Decimal | null;
        sku: string | null;
        stock_quantity: number | null;
        product_id: string;
        price_adjustment: import("@prisma/client/runtime/library").Decimal;
    }>;
}
