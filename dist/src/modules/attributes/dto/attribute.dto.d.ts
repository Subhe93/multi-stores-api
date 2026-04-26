import { AttributeType } from '@prisma/client';
export declare class CreateAttributeTemplateDto {
    name: string;
    type: AttributeType;
    unit?: string;
    options?: any;
    is_required?: boolean;
    group_name?: string;
    validation_rules?: any;
    sort_order?: number;
    translations?: AttributeTranslationDto[];
}
export declare class AttributeTranslationDto {
    locale: string;
    label: string;
    option_labels?: any;
}
export declare class UpdateAttributeTemplateDto {
    name?: string;
    type?: AttributeType;
    unit?: string;
    options?: any;
    is_required?: boolean;
    group_name?: string;
    validation_rules?: any;
    sort_order?: number;
    translations?: AttributeTranslationDto[];
}
