import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto, LinkAttributesDto } from './dto/category.dto';
export declare class CategoriesService {
    private prisma;
    constructor(prisma: PrismaService);
    create(dto: CreateCategoryDto): Promise<{
        translations: {
            id: string;
            name: string;
            description: string | null;
            locale: string;
            category_id: string;
        }[];
    } & {
        id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        icon: string | null;
    }>;
    findAll(): Promise<({
        translations: {
            id: string;
            name: string;
            description: string | null;
            locale: string;
            category_id: string;
        }[];
        children: ({
            translations: {
                id: string;
                name: string;
                description: string | null;
                locale: string;
                category_id: string;
            }[];
            children: ({
                translations: {
                    id: string;
                    name: string;
                    description: string | null;
                    locale: string;
                    category_id: string;
                }[];
            } & {
                id: string;
                slug: string;
                is_active: boolean;
                sort_order: number;
                parent_id: string | null;
                icon: string | null;
            })[];
        } & {
            id: string;
            slug: string;
            is_active: boolean;
            sort_order: number;
            parent_id: string | null;
            icon: string | null;
        })[];
    } & {
        id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        icon: string | null;
    })[]>;
    findById(id: string): Promise<{
        translations: {
            id: string;
            name: string;
            description: string | null;
            locale: string;
            category_id: string;
        }[];
        children: ({
            translations: {
                id: string;
                name: string;
                description: string | null;
                locale: string;
                category_id: string;
            }[];
        } & {
            id: string;
            slug: string;
            is_active: boolean;
            sort_order: number;
            parent_id: string | null;
            icon: string | null;
        })[];
        attribute_templates: ({
            template: {
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
            };
        } & {
            category_id: string;
            template_id: string;
        })[];
    } & {
        id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        icon: string | null;
    }>;
    findBySlug(slug: string): Promise<{
        translations: {
            id: string;
            name: string;
            description: string | null;
            locale: string;
            category_id: string;
        }[];
        children: ({
            translations: {
                id: string;
                name: string;
                description: string | null;
                locale: string;
                category_id: string;
            }[];
        } & {
            id: string;
            slug: string;
            is_active: boolean;
            sort_order: number;
            parent_id: string | null;
            icon: string | null;
        })[];
        attribute_templates: ({
            template: {
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
            };
        } & {
            category_id: string;
            template_id: string;
        })[];
    } & {
        id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        icon: string | null;
    }>;
    update(id: string, dto: UpdateCategoryDto): Promise<{
        translations: {
            id: string;
            name: string;
            description: string | null;
            locale: string;
            category_id: string;
        }[];
    } & {
        id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        icon: string | null;
    }>;
    delete(id: string): Promise<{
        id: string;
        slug: string;
        is_active: boolean;
        sort_order: number;
        parent_id: string | null;
        icon: string | null;
    }>;
    getAttributeTemplates(id: string): Promise<({
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
    linkAttributes(id: string, dto: LinkAttributesDto): Promise<({
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
}
