export declare class FaqTranslationDto {
    locale: string;
    question: string;
    answer: string;
}
export declare class CreateProductFaqDto {
    sort_order?: number;
    translations: FaqTranslationDto[];
}
export declare class UpdateProductFaqDto {
    sort_order?: number;
    translations?: FaqTranslationDto[];
}
