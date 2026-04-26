import { PrismaService } from '../../prisma/prisma.service';
import { AutoTranslateDto, BulkTranslateDto, TranslatableEntity } from './dto/translation.dto';
export declare class TranslationsService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    getOverview(userId: string): Promise<{
        store_id: string | null;
        primary_locale: string;
        secondary_locales: string[];
        products: {
            id: any;
            type: string;
            title: any;
            translated_locales: string[];
        }[];
        custom_products: {
            id: any;
            type: string;
            title: any;
            translated_locales: string[];
        }[];
        pages: {
            id: any;
            type: string;
            title: any;
            translated_locales: string[];
        }[];
    }>;
    autoTranslate(dto: AutoTranslateDto): Promise<{
        entity_type: TranslatableEntity;
        entity_id: string;
        source_locale: string;
        target_locale: string;
        translated: Record<string, string>;
    }>;
    translateSingleText(text: string, sourceLocale: string, targetLocale: string): Promise<{
        translated: string;
    }>;
    bulkTranslate(dto: BulkTranslateDto): Promise<{
        store_id: string;
        target_locale: string;
        results: Record<string, {
            total: number;
            translated: number;
            skipped: number;
        }>;
    }>;
    private bulkTranslateProducts;
    private bulkTranslateCustomProducts;
    private bulkTranslatePages;
    private getSourceTranslation;
    private saveTranslation;
    private translateFields;
    private callMyMemory;
    private splitText;
    private generateSlug;
}
