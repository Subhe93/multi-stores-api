import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateLegalPageDto } from './dto/legal.dto';
import { RevalidationService } from '../../common/revalidation/revalidation.service';

type Localized = Record<string, string>;

/**
 * Platform legal pages (privacy, terms, refund, shipping). Per-locale title +
 * content are stored as JSON on a single row keyed by slug. Public reads pick
 * the requested locale with an English (then any-available) fallback so a page
 * always renders even when a translation is missing.
 */
@Injectable()
export class LegalService {
  constructor(
    private prisma: PrismaService,
    private revalidation: RevalidationService,
  ) {}

  /**
   * The key a localized value is read from: the requested locale (matched
   * case-insensitively), else `en`, else the first key; null when empty.
   */
  private localeKey(json: unknown, locale?: string): string | null {
    const obj = (json || {}) as Localized;
    if (locale) {
      if (obj[locale]) return locale;
      const lower = locale.toLowerCase();
      const ci = Object.keys(obj).find(
        (k) => k.toLowerCase() === lower && obj[k],
      );
      if (ci) return ci;
    }
    if (obj.en) return 'en';
    return Object.keys(obj)[0] ?? null;
  }

  private pickLocale(json: unknown, locale?: string): string {
    const key = this.localeKey(json, locale);
    const value = key ? (json as Localized)[key] : undefined;
    return typeof value === 'string' ? value : '';
  }

  /** Public: list all legal pages with the requested locale's title. */
  async list(locale?: string) {
    const pages = await this.prisma.legalPage.findMany({
      orderBy: { slug: 'asc' },
    });
    return pages.map((p) => ({
      slug: p.slug,
      title: this.pickLocale(p.title, locale),
      updated_at: p.updated_at,
    }));
  }

  /** Public: fetch one page in the requested locale (with fallback). */
  async findBySlug(slug: string, locale?: string) {
    const page = await this.prisma.legalPage.findUnique({ where: { slug } });
    if (!page) throw new NotFoundException('Legal page not found');
    return {
      slug: page.slug,
      title: this.pickLocale(page.title, locale),
      content: this.pickLocale(page.content, locale),
      // The locale the content is written in (after fallback).
      locale: this.localeKey(page.content, locale) ?? 'en',
      updated_at: page.updated_at,
    };
  }

  /** Admin: full JSON (all locales) for the editor. */
  async listAdmin() {
    return this.prisma.legalPage.findMany({ orderBy: { slug: 'asc' } });
  }

  async findBySlugAdmin(slug: string) {
    const page = await this.prisma.legalPage.findUnique({ where: { slug } });
    if (!page) throw new NotFoundException('Legal page not found');
    return page;
  }

  /**
   * Admin partial update: merges the provided locale keys into the existing
   * title/content JSON so editing one language doesn't drop the others.
   */
  async update(slug: string, dto: UpdateLegalPageDto) {
    const page = await this.prisma.legalPage.findUnique({ where: { slug } });
    if (!page) throw new NotFoundException('Legal page not found');

    const mergedTitle = dto.title
      ? { ...(page.title as Localized), ...dto.title }
      : page.title;
    const mergedContent = dto.content
      ? { ...(page.content as Localized), ...dto.content }
      : page.content;

    const updated = await this.prisma.legalPage.update({
      where: { slug },
      data: { title: mergedTitle as object, content: mergedContent as object },
    });
    // The storefront caches legal pages for an hour; purge right away so an
    // admin edit is visible immediately (best effort, never blocks the save).
    void Promise.all([
      this.revalidation.revalidateTag('legal'),
      this.revalidation.revalidateTag(`legal:${slug}`),
    ]).catch(() => undefined);
    return updated;
  }
}
