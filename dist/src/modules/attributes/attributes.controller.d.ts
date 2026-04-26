import { AttributesService } from './attributes.service';
import { CreateAttributeTemplateDto, UpdateAttributeTemplateDto } from './dto/attribute.dto';
export declare class AttributesController {
    private attributesService;
    constructor(attributesService: AttributesService);
    create(dto: CreateAttributeTemplateDto): Promise<{
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            template_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.AttributeType;
        unit: string | null;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        group_name: string | null;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
    }>;
    findAll(): Promise<({
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            template_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.AttributeType;
        unit: string | null;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        group_name: string | null;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
    })[]>;
    findById(id: string): Promise<{
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            template_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.AttributeType;
        unit: string | null;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        group_name: string | null;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
    }>;
    update(id: string, dto: UpdateAttributeTemplateDto): Promise<{
        translations: {
            id: string;
            label: string;
            locale: string;
            option_labels: import("@prisma/client/runtime/library").JsonValue | null;
            template_id: string;
        }[];
    } & {
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.AttributeType;
        unit: string | null;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        group_name: string | null;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
    }>;
    delete(id: string): Promise<{
        id: string;
        name: string;
        type: import("@prisma/client").$Enums.AttributeType;
        unit: string | null;
        options: import("@prisma/client/runtime/library").JsonValue | null;
        is_required: boolean;
        group_name: string | null;
        validation_rules: import("@prisma/client/runtime/library").JsonValue | null;
        sort_order: number;
    }>;
}
