import { CustomFieldType } from '@prisma/client';
export declare class CustomFieldTranslationDto {
    locale: string;
    label: string;
    placeholder?: string;
    option_labels?: any;
}
export declare class CreateCustomFieldDto {
    name: string;
    type: CustomFieldType;
    is_required?: boolean;
    placeholder?: string;
    options?: any;
    validation_rules?: any;
    linked_validation?: any;
    sort_order?: number;
    translations?: CustomFieldTranslationDto[];
}
export declare class UpdateCustomFieldDto {
    name?: string;
    type?: CustomFieldType;
    is_required?: boolean;
    placeholder?: string;
    options?: any;
    validation_rules?: any;
    linked_validation?: any;
    sort_order?: number;
    translations?: CustomFieldTranslationDto[];
}
