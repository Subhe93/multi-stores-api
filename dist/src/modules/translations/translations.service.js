"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var TranslationsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslationsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const translation_dto_1 = require("./dto/translation.dto");
let TranslationsService = TranslationsService_1 = class TranslationsService {
    prisma;
    logger = new common_1.Logger(TranslationsService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getOverview(userId) {
        const creator = await this.prisma.creator.findUnique({
            where: { user_id: userId },
        });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const store = await this.prisma.store.findUnique({
            where: { creator_id: creator.id },
            include: { language_config: true },
        });
        const primaryLocale = store?.language_config?.primary_locale ?? 'en';
        const secondaryLocales = store?.language_config?.secondary_locales ?? [];
        const [products, customProducts, pages] = await Promise.all([
            this.prisma.product.findMany({
                where: { creator_id: creator.id },
                include: { translations: true },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.customProduct.findMany({
                where: { creator_id: creator.id },
                include: { translations: true },
                orderBy: { created_at: 'desc' },
            }),
            store
                ? this.prisma.staticPage.findMany({
                    where: { store_id: store.id },
                    include: { translations: true },
                    orderBy: { created_at: 'desc' },
                })
                : Promise.resolve([]),
        ]);
        const mapEntity = (entities, type) => entities.map((e) => {
            const t = e.translations ?? [];
            const primaryT = t.find((x) => x.locale === primaryLocale) ?? t[0];
            return {
                id: e.id,
                type,
                title: primaryT?.title ?? primaryT?.name ?? e.slug ?? 'Untitled',
                translated_locales: t.map((x) => x.locale),
            };
        });
        return {
            store_id: store?.id ?? null,
            primary_locale: primaryLocale,
            secondary_locales: secondaryLocales,
            products: mapEntity(products, 'product'),
            custom_products: mapEntity(customProducts, 'custom_product'),
            pages: mapEntity(pages, 'static_page'),
        };
    }
    async autoTranslate(dto) {
        const { entity_type, entity_id, source_locale, target_locale } = dto;
        const sourceText = await this.getSourceTranslation(entity_type, entity_id, source_locale);
        if (!sourceText) {
            throw new common_1.NotFoundException(`No ${source_locale} translation found for ${entity_type} ${entity_id}`);
        }
        const translated = await this.translateFields(sourceText, source_locale, target_locale);
        await this.saveTranslation(entity_type, entity_id, target_locale, translated);
        return { entity_type, entity_id, source_locale, target_locale, translated };
    }
    async translateSingleText(text, sourceLocale, targetLocale) {
        const translated = await this.callMyMemory(text, sourceLocale, targetLocale);
        return { translated };
    }
    async bulkTranslate(dto) {
        const store = await this.prisma.store.findUnique({
            where: { id: dto.store_id },
            include: { language_config: true, creator: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const sourceLocale = dto.source_locale || store.language_config?.primary_locale || 'en';
        const entityTypes = dto.entity_types ?? ['products'];
        const results = {};
        if (entityTypes.includes('products') || entityTypes.includes('all')) {
            results.products = await this.bulkTranslateProducts(store.creator.id, sourceLocale, dto.target_locale);
        }
        if (entityTypes.includes('custom_products') || entityTypes.includes('all')) {
            results.custom_products = await this.bulkTranslateCustomProducts(store.creator.id, sourceLocale, dto.target_locale);
        }
        if (entityTypes.includes('pages') || entityTypes.includes('all')) {
            results.pages = await this.bulkTranslatePages(store.id, sourceLocale, dto.target_locale);
        }
        return { store_id: dto.store_id, target_locale: dto.target_locale, results };
    }
    async bulkTranslateProducts(creatorId, sourceLocale, targetLocale) {
        const products = await this.prisma.product.findMany({
            where: { creator_id: creatorId },
            include: { translations: true },
        });
        let translated = 0, skipped = 0;
        for (const product of products) {
            const source = product.translations.find((t) => t.locale === sourceLocale);
            const existing = product.translations.find((t) => t.locale === targetLocale);
            if (!source || existing) {
                skipped++;
                continue;
            }
            try {
                const result = await this.translateFields({ title: source.title, description: source.description }, sourceLocale, targetLocale);
                await this.prisma.productTranslation.create({
                    data: {
                        product_id: product.id,
                        locale: targetLocale,
                        title: result.title || source.title,
                        description: result.description || source.description,
                        slug: this.generateSlug(result.title || source.title),
                    },
                });
                translated++;
            }
            catch (err) {
                this.logger.error(`Product ${product.id}: ${err}`);
                skipped++;
            }
        }
        return { total: products.length, translated, skipped };
    }
    async bulkTranslateCustomProducts(creatorId, sourceLocale, targetLocale) {
        const items = await this.prisma.customProduct.findMany({
            where: { creator_id: creatorId },
            include: { translations: true },
        });
        let translated = 0, skipped = 0;
        for (const item of items) {
            const source = item.translations.find((t) => t.locale === sourceLocale);
            const existing = item.translations.find((t) => t.locale === targetLocale);
            if (!source || existing) {
                skipped++;
                continue;
            }
            try {
                const result = await this.translateFields({ title: source.title, description: source.description ?? '' }, sourceLocale, targetLocale);
                await this.prisma.customProductTranslation.create({
                    data: {
                        custom_product_id: item.id,
                        locale: targetLocale,
                        title: result.title || source.title,
                        description: result.description || source.description,
                        slug: this.generateSlug(result.title || source.title),
                    },
                });
                translated++;
            }
            catch (err) {
                this.logger.error(`CustomProduct ${item.id}: ${err}`);
                skipped++;
            }
        }
        return { total: items.length, translated, skipped };
    }
    async bulkTranslatePages(storeId, sourceLocale, targetLocale) {
        const pages = await this.prisma.staticPage.findMany({
            where: { store_id: storeId },
            include: { translations: true },
        });
        let translated = 0, skipped = 0;
        for (const page of pages) {
            const source = page.translations.find((t) => t.locale === sourceLocale);
            const existing = page.translations.find((t) => t.locale === targetLocale);
            if (!source || existing) {
                skipped++;
                continue;
            }
            try {
                const result = await this.translateFields({ title: source.title, content: source.content ?? '' }, sourceLocale, targetLocale);
                await this.prisma.staticPageTranslation.upsert({
                    where: { page_id_locale: { page_id: page.id, locale: targetLocale } },
                    update: { title: result.title || source.title, content: result.content },
                    create: {
                        page_id: page.id,
                        locale: targetLocale,
                        title: result.title || source.title,
                        content: result.content,
                    },
                });
                translated++;
            }
            catch (err) {
                this.logger.error(`Page ${page.id}: ${err}`);
                skipped++;
            }
        }
        return { total: pages.length, translated, skipped };
    }
    async getSourceTranslation(entityType, entityId, locale) {
        switch (entityType) {
            case translation_dto_1.TranslatableEntity.PRODUCT: {
                const t = await this.prisma.productTranslation.findUnique({
                    where: { product_id_locale: { product_id: entityId, locale } },
                });
                return t ? { title: t.title, description: t.description } : null;
            }
            case translation_dto_1.TranslatableEntity.CATEGORY: {
                const t = await this.prisma.categoryTranslation.findUnique({
                    where: { category_id_locale: { category_id: entityId, locale } },
                });
                return t ? { name: t.name, description: t.description || '' } : null;
            }
            case translation_dto_1.TranslatableEntity.STATIC_PAGE: {
                const t = await this.prisma.staticPageTranslation.findUnique({
                    where: { page_id_locale: { page_id: entityId, locale } },
                });
                return t ? { title: t.title, content: t.content || '' } : null;
            }
            case translation_dto_1.TranslatableEntity.CUSTOM_PRODUCT: {
                const t = await this.prisma.customProductTranslation.findUnique({
                    where: { custom_product_id_locale: { custom_product_id: entityId, locale } },
                });
                return t ? { title: t.title, description: t.description || '' } : null;
            }
            default:
                return null;
        }
    }
    async saveTranslation(entityType, entityId, locale, translated) {
        switch (entityType) {
            case translation_dto_1.TranslatableEntity.PRODUCT:
                await this.prisma.productTranslation.upsert({
                    where: { product_id_locale: { product_id: entityId, locale } },
                    update: { title: translated.title, description: translated.description },
                    create: {
                        product_id: entityId,
                        locale,
                        title: translated.title,
                        description: translated.description,
                        slug: this.generateSlug(translated.title),
                    },
                });
                break;
            case translation_dto_1.TranslatableEntity.CATEGORY:
                await this.prisma.categoryTranslation.upsert({
                    where: { category_id_locale: { category_id: entityId, locale } },
                    update: { name: translated.name, description: translated.description },
                    create: { category_id: entityId, locale, name: translated.name, description: translated.description },
                });
                break;
            case translation_dto_1.TranslatableEntity.STATIC_PAGE:
                await this.prisma.staticPageTranslation.upsert({
                    where: { page_id_locale: { page_id: entityId, locale } },
                    update: { title: translated.title, content: translated.content },
                    create: { page_id: entityId, locale, title: translated.title, content: translated.content },
                });
                break;
            case translation_dto_1.TranslatableEntity.CUSTOM_PRODUCT:
                await this.prisma.customProductTranslation.upsert({
                    where: { custom_product_id_locale: { custom_product_id: entityId, locale } },
                    update: { title: translated.title, description: translated.description },
                    create: {
                        custom_product_id: entityId,
                        locale,
                        title: translated.title,
                        description: translated.description,
                        slug: this.generateSlug(translated.title),
                    },
                });
                break;
        }
    }
    async translateFields(source, sourceLocale, targetLocale) {
        const result = {};
        for (const [key, value] of Object.entries(source)) {
            if (!value?.trim()) {
                result[key] = value;
                continue;
            }
            try {
                result[key] = await this.callMyMemory(value, sourceLocale, targetLocale);
            }
            catch (err) {
                this.logger.warn(`MyMemory failed for "${key}": ${err}`);
                result[key] = value;
            }
        }
        return result;
    }
    async callMyMemory(text, sourceLang, targetLang) {
        const MAX_CHARS = 400;
        const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!plain)
            return text;
        const chunks = this.splitText(plain, MAX_CHARS);
        const translatedChunks = [];
        for (const chunk of chunks) {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${sourceLang}|${targetLang}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const data = await res.json();
            if (data.responseStatus === 200 && data.responseData?.translatedText) {
                translatedChunks.push(data.responseData.translatedText);
            }
            else {
                this.logger.warn(`MyMemory status ${data.responseStatus} for: "${chunk.substring(0, 40)}..."`);
                translatedChunks.push(chunk);
            }
            if (chunks.length > 1)
                await new Promise(r => setTimeout(r, 200));
        }
        return translatedChunks.join(' ');
    }
    splitText(text, maxChars) {
        if (text.length <= maxChars)
            return [text];
        const chunks = [];
        const sentences = text.split(/(?<=[.!?])\s+/);
        let current = '';
        for (const sentence of sentences) {
            if ((current + ' ' + sentence).trim().length <= maxChars) {
                current = (current + ' ' + sentence).trim();
            }
            else {
                if (current)
                    chunks.push(current);
                if (sentence.length > maxChars) {
                    const words = sentence.split(' ');
                    let wordChunk = '';
                    for (const word of words) {
                        if ((wordChunk + ' ' + word).trim().length <= maxChars) {
                            wordChunk = (wordChunk + ' ' + word).trim();
                        }
                        else {
                            if (wordChunk)
                                chunks.push(wordChunk);
                            wordChunk = word;
                        }
                    }
                    current = wordChunk;
                }
                else {
                    current = sentence;
                }
            }
        }
        if (current)
            chunks.push(current);
        return chunks;
    }
    generateSlug(text) {
        return text
            .toLowerCase()
            .replace(/[\u0600-\u06FF]/g, '')
            .replace(/[^\w\s-]/g, '')
            .replace(/[\s_]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 100) || `item-${Date.now()}`;
    }
};
exports.TranslationsService = TranslationsService;
exports.TranslationsService = TranslationsService = TranslationsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TranslationsService);
//# sourceMappingURL=translations.service.js.map