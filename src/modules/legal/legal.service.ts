import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateLegalPageDto } from './dto/legal.dto';

type Localized = Record<string, string>;

/**
 * Platform legal pages (privacy, terms, refund, shipping). Per-locale title +
 * content are stored as JSON on a single row keyed by slug. Public reads pick
 * the requested locale with an English (then any-available) fallback so a page
 * always renders even when a translation is missing.
 */
@Injectable()
export class LegalService {
  constructor(private prisma: PrismaService) {}

  private pickLocale(json: unknown, locale?: string): string {
    const obj = (json || {}) as Localized;
    if (locale && obj[locale]) return obj[locale];
    if (obj.en) return obj.en;
    const first = Object.values(obj)[0];
    return typeof first === 'string' ? first : '';
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

    return this.prisma.legalPage.update({
      where: { slug },
      data: { title: mergedTitle as object, content: mergedContent as object },
    });
  }
}
