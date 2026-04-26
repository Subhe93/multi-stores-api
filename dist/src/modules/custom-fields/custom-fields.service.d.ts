import { PrismaService } from '../../prisma/prisma.service';
import { CreateCustomFieldDto, UpdateCustomFieldDto } from './dto/custom-field.dto';
export declare class CustomFieldsService {
    private prisma;
    constructor(prisma: PrismaService);
    create(productId: string, dto: CreateCustomFieldDto): Promise<{
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            placeholder: string | null;
            field_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.CustomFieldType;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
        product_id: string;
        placeholder: string | null;
        linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
    findByProduct(productId: string): Promise<({
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            placeholder: string | null;
            field_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.CustomFieldType;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
        product_id: string;
        placeholder: string | null;
        linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
    })[]>;
    update(id: string, dto: UpdateCustomFieldDto): Promise<{
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            placeholder: string | null;
            field_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.CustomFieldType;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
        product_id: string;
        placeholder: string | null;
        linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
    delete(id: string): Promise<{
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.CustomFieldType;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
        product_id: string;
        placeholder: string | null;
        linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
    }>;
    reorder(productId: string, fieldIds: string[]): Promise<({
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            placeholder: string | null;
            field_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.CustomFieldType;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
        product_id: string;
        placeholder: string | null;
        linked_validation: import("@prisma/client/runtime/library").JsonValue | null;
    })[]>;
}
