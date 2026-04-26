import { TranslationsService } from './translations.service';
import { AutoTranslateDto, BulkTranslateDto } from './dto/translation.dto';
declare class TranslateTextDto {
    text: string;
    source_locale: string;
    target_locale: string;
}
export declare class TranslationsController {
    private translationsService;
    constructor(translationsService: TranslationsService);
    getOverview(req: any): Promise<{
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
        entity_type: import("./dto/translation.dto").TranslatableEntity;
        entity_id: string;
        source_locale: string;
        target_locale: string;
        translated: Record<string, string>;
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
    translateText(dto: TranslateTextDto): Promise<{
        translated: string;
    }>;
}
export {};
