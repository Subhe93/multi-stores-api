import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AutoTranslateDto,
  BulkTranslateDto,
  TranslatableEntity,
} from './dto/translation.dto';

@Injectable()
export class TranslationsService {
  private readonly logger = new Logger(TranslationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Returns full translation status overview for all the creator's entities.
   * Used by the /creator/translations management page.
   */
  async getOverview(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException({ code: 'TRANSLATION_CREATOR_NOT_FOUND', message: 'Creator not found' });

    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      include: { language_config: true },
    });
    const primaryLocale = store?.language_config?.primary_locale ?? 'en';
    const secondaryLocales: string[] = store?.language_config?.secondary_locales ?? [];

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

    const mapEntity = (entities: any[], type: string) =>
      entities.map((e) => {
        const t = e.translations ?? [];
        const primaryT = t.find((x: any) => x.locale === primaryLocale) ?? t[0];
        return {
          id: e.id,
          type,
          title: primaryT?.title ?? primaryT?.name ?? e.slug ?? 'Untitled',
          translated_locales: t.map((x: any) => x.locale) as string[],
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

  /**
   * Translate a single entity from source to target locale.
   */
  async autoTranslate(dto: AutoTranslateDto, userId: string, userRole: UserRole) {
    const { entity_type, entity_id, source_locale, target_locale } = dto;
    await this.assertOwnsEntity(entity_type, entity_id, userId, userRole);

    const sourceText = await this.getSourceTranslation(entity_type, entity_id, source_locale);
    if (!sourceText) {
      throw new NotFoundException(
        `No ${source_locale} translation found for ${entity_type} ${entity_id}`,
      );
    }

    const translated = await this.translateFields(sourceText, source_locale, target_locale);
    await this.saveTranslation(entity_type, entity_id, target_locale, translated);

    return { entity_type, entity_id, source_locale, target_locale, translated };
  }

  /**
   * Translate raw text directly — used by dashboard forms before entity is saved.
   */
  async translateSingleText(text: string, sourceLocale: string, targetLocale: string) {
    const translated = await this.callMyMemory(text, sourceLocale, targetLocale);
    return { translated };
  }

  /**
   * Bulk translate all entities of specified types for a store.
   * entity_types: 'products' | 'custom_products' | 'designs' | 'pages' | 'all'
   */
  async bulkTranslate(dto: BulkTranslateDto, userId: string, userRole: UserRole) {
    const store = await this.prisma.store.findUnique({
      where: { id: dto.store_id },
      include: { language_config: true, creator: true },
    });
    if (!store) throw new NotFoundException({ code: 'TRANSLATION_STORE_NOT_FOUND', message: 'Store not found' });
    // Otherwise any creator could overwrite a rival store's whole catalogue of
    // translations and run up its external translation-API usage.
    this.assertOwnsStore(store.creator.user_id, userId, userRole);

    const sourceLocale = dto.source_locale || store.language_config?.primary_locale || 'en';
    const entityTypes = dto.entity_types ?? ['products'];

    const results: Record<string, { total: number; translated: number; skipped: number }> = {};

    if (entityTypes.includes('products') || entityTypes.includes('all')) {
      results.products = await this.bulkTranslateProducts(
        store.creator.id, sourceLocale, dto.target_locale,
      );
    }

    if (entityTypes.includes('custom_products') || entityTypes.includes('all')) {
      results.custom_products = await this.bulkTranslateCustomProducts(
        store.creator.id, sourceLocale, dto.target_locale,
      );
    }

    if (entityTypes.includes('pages') || entityTypes.includes('all')) {
      results.pages = await this.bulkTranslatePages(
        store.id, sourceLocale, dto.target_locale,
      );
    }

    return { store_id: dto.store_id, target_locale: dto.target_locale, results };
  }

  // ──────────────────────────────────────────────────────────
  // Private bulk helpers
  // ──────────────────────────────────────────────────────────

  private async bulkTranslateProducts(creatorId: string, sourceLocale: string, targetLocale: string) {
    const products = await this.prisma.product.findMany({
      where: { creator_id: creatorId },
      include: { translations: true },
    });

    let translated = 0, skipped = 0;

    for (const product of products) {
      const source = product.translations.find((t) => t.locale === sourceLocale);
      const existing = product.translations.find((t) => t.locale === targetLocale);
      if (!source || existing) { skipped++; continue; }

      try {
        const result = await this.translateFields(
          { title: source.title, description: source.description },
          sourceLocale, targetLocale,
        );
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
      } catch (err) {
        this.logger.error(`Product ${product.id}: ${err}`);
        skipped++;
      }
    }

    return { total: products.length, translated, skipped };
  }

  private async bulkTranslateCustomProducts(creatorId: string, sourceLocale: string, targetLocale: string) {
    const items = await this.prisma.customProduct.findMany({
      where: { creator_id: creatorId },
      include: { translations: true },
    });

    let translated = 0, skipped = 0;

    for (const item of items) {
      const source = item.translations.find((t) => t.locale === sourceLocale);
      const existing = item.translations.find((t) => t.locale === targetLocale);
      if (!source || existing) { skipped++; continue; }

      try {
        const result = await this.translateFields(
          { title: source.title, description: source.description ?? '' },
          sourceLocale, targetLocale,
        );
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
      } catch (err) {
        this.logger.error(`CustomProduct ${item.id}: ${err}`);
        skipped++;
      }
    }

    return { total: items.length, translated, skipped };
  }

  private async bulkTranslatePages(storeId: string, sourceLocale: string, targetLocale: string) {
    const pages = await this.prisma.staticPage.findMany({
      where: { store_id: storeId },
      include: { translations: true },
    });

    let translated = 0, skipped = 0;

    for (const page of pages) {
      const source = page.translations.find((t) => t.locale === sourceLocale);
      const existing = page.translations.find((t) => t.locale === targetLocale);
      if (!source || existing) { skipped++; continue; }

      try {
        const result = await this.translateFields(
          { title: source.title, content: source.content ?? '' },
          sourceLocale, targetLocale,
        );
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
      } catch (err) {
        this.logger.error(`Page ${page.id}: ${err}`);
        skipped++;
      }
    }

    return { total: pages.length, translated, skipped };
  }

  // ──────────────────────────────────────────────────────────
  // Auto-translate single entity (reads from DB, saves to DB)
  // ──────────────────────────────────────────────────────────

  /**
   * The entity id arrives from the client and translations are written straight
   * back to it, so a caller must own the entity. CATEGORY is platform-owned and
   * therefore admin-only; the remaining types resolve to a creator.
   */
  private async assertOwnsEntity(
    entityType: TranslatableEntity,
    entityId: string,
    userId: string,
    userRole: UserRole,
  ): Promise<void> {
    if (userRole === UserRole.ADMIN) return;

    const denied = () => {
      throw new ForbiddenException({
        code: 'TRANSLATION_ENTITY_FORBIDDEN',
        message: 'You can only translate your own content',
      });
    };

    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator) denied();

    switch (entityType) {
      case TranslatableEntity.PRODUCT: {
        const product = await this.prisma.product.findUnique({
          where: { id: entityId },
          select: { creator_id: true },
        });
        if (!product || product.creator_id !== creator!.id) denied();
        return;
      }
      case TranslatableEntity.CUSTOM_PRODUCT: {
        const cp = await this.prisma.customProduct.findUnique({
          where: { id: entityId },
          select: { creator_id: true },
        });
        if (!cp || cp.creator_id !== creator!.id) denied();
        return;
      }
      case TranslatableEntity.STATIC_PAGE: {
        const page = await this.prisma.staticPage.findUnique({
          where: { id: entityId },
          select: { store: { select: { creator_id: true } } },
        });
        if (!page || page.store.creator_id !== creator!.id) denied();
        return;
      }
      case TranslatableEntity.PROMOTION: {
        const promo = await this.prisma.promotion.findUnique({
          where: { id: entityId },
          select: { creator_id: true },
        });
        if (!promo || promo.creator_id !== creator!.id) denied();
        return;
      }
      default:
        // CATEGORY and CUSTOM_FIELD are not creator-scoped — admins only.
        denied();
    }
  }

  private assertOwnsStore(
    storeOwnerUserId: string,
    userId: string,
    userRole: UserRole,
  ): void {
    if (userRole === UserRole.ADMIN) return;
    if (storeOwnerUserId !== userId) {
      throw new ForbiddenException({
        code: 'TRANSLATION_STORE_FORBIDDEN',
        message: 'You can only translate your own store',
      });
    }
  }

  private async getSourceTranslation(
    entityType: TranslatableEntity,
    entityId: string,
    locale: string,
  ): Promise<Record<string, string> | null> {
    switch (entityType) {
      case TranslatableEntity.PRODUCT: {
        const t = await this.prisma.productTranslation.findUnique({
          where: { product_id_locale: { product_id: entityId, locale } },
        });
        return t ? { title: t.title, description: t.description } : null;
      }
      case TranslatableEntity.CATEGORY: {
        const t = await this.prisma.categoryTranslation.findUnique({
          where: { category_id_locale: { category_id: entityId, locale } },
        });
        return t ? { name: t.name, description: t.description || '' } : null;
      }
      case TranslatableEntity.STATIC_PAGE: {
        const t = await this.prisma.staticPageTranslation.findUnique({
          where: { page_id_locale: { page_id: entityId, locale } },
        });
        return t ? { title: t.title, content: t.content || '' } : null;
      }
      case TranslatableEntity.CUSTOM_PRODUCT: {
        const t = await this.prisma.customProductTranslation.findUnique({
          where: { custom_product_id_locale: { custom_product_id: entityId, locale } },
        });
        return t ? { title: t.title, description: t.description || '' } : null;
      }
      default:
        return null;
    }
  }

  private async saveTranslation(
    entityType: TranslatableEntity,
    entityId: string,
    locale: string,
    translated: Record<string, string>,
  ) {
    switch (entityType) {
      case TranslatableEntity.PRODUCT:
        await this.prisma.productTranslation.upsert({
          where: { product_id_locale: { product_id: entityId, locale } },
          update: { title: translated.title!, description: translated.description! },
          create: {
            product_id: entityId,
            locale,
            title: translated.title!,
            description: translated.description!,
            slug: this.generateSlug(translated.title!),
          },
        });
        break;

      case TranslatableEntity.CATEGORY:
        await this.prisma.categoryTranslation.upsert({
          where: { category_id_locale: { category_id: entityId, locale } },
          update: { name: translated.name!, description: translated.description },
          create: { category_id: entityId, locale, name: translated.name!, description: translated.description },
        });
        break;



      case TranslatableEntity.STATIC_PAGE:
        await this.prisma.staticPageTranslation.upsert({
          where: { page_id_locale: { page_id: entityId, locale } },
          update: { title: translated.title!, content: translated.content },
          create: { page_id: entityId, locale, title: translated.title!, content: translated.content },
        });
        break;

      case TranslatableEntity.CUSTOM_PRODUCT:
        await this.prisma.customProductTranslation.upsert({
          where: { custom_product_id_locale: { custom_product_id: entityId, locale } },
          update: { title: translated.title!, description: translated.description },
          create: {
            custom_product_id: entityId,
            locale,
            title: translated.title!,
            description: translated.description,
            slug: this.generateSlug(translated.title!),
          },
        });
        break;
    }
  }

  // ──────────────────────────────────────────────────────────
  // MyMemory free translation API
  // ──────────────────────────────────────────────────────────

  private async translateFields(
    source: Record<string, string>,
    sourceLocale: string,
    targetLocale: string,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!value?.trim()) { result[key] = value; continue; }
      try {
        result[key] = await this.callMyMemory(value, sourceLocale, targetLocale);
      } catch (err) {
        this.logger.warn(`MyMemory failed for "${key}": ${err}`);
        result[key] = value;
      }
    }
    return result;
  }

  private async callMyMemory(text: string, sourceLang: string, targetLang: string): Promise<string> {
    const MAX_CHARS = 400;
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain) return text;

    const chunks = this.splitText(plain, MAX_CHARS);
    const translatedChunks: string[] = [];

    for (const chunk of chunks) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${sourceLang}|${targetLang}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json() as { responseData: { translatedText: string }; responseStatus: number };

      if (data.responseStatus === 200 && data.responseData?.translatedText) {
        translatedChunks.push(data.responseData.translatedText);
      } else {
        this.logger.warn(`MyMemory status ${data.responseStatus} for: "${chunk.substring(0, 40)}..."`);
        translatedChunks.push(chunk);
      }

      if (chunks.length > 1) await new Promise(r => setTimeout(r, 200));
    }

    return translatedChunks.join(' ');
  }

  private splitText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    let current = '';

    for (const sentence of sentences) {
      if ((current + ' ' + sentence).trim().length <= maxChars) {
        current = (current + ' ' + sentence).trim();
      } else {
        if (current) chunks.push(current);
        if (sentence.length > maxChars) {
          const words = sentence.split(' ');
          let wordChunk = '';
          for (const word of words) {
            if ((wordChunk + ' ' + word).trim().length <= maxChars) {
              wordChunk = (wordChunk + ' ' + word).trim();
            } else {
              if (wordChunk) chunks.push(wordChunk);
              wordChunk = word;
            }
          }
          current = wordChunk;
        } else {
          current = sentence;
        }
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  private generateSlug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[\u0600-\u06FF]/g, '')
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 100) || `item-${Date.now()}`;
  }
}
