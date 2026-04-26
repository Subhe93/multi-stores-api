import { StaticPageType, PageStatus } from '@prisma/client';
export declare class PageTranslationDto {
    locale: string;
    title: string;
    content?: string;
}
export declare class CreatePageDto {
    type: StaticPageType;
    slug: string;
    sort_order?: number;
    translations?: PageTranslationDto[];
}
export declare class UpdatePageDto {
    slug?: string;
    status?: PageStatus;
    sort_order?: number;
    translations?: PageTranslationDto[];
}
