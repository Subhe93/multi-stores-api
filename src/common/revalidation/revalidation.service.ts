import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tells the storefront (Next.js) to drop its cached data for a store after a
 * mutation, so creators see published changes within seconds. Fire-and-forget:
 * a failed revalidation must never break the originating mutation — the
 * time-based revalidate fallback on the web side eventually catches up.
 */
@Injectable()
export class RevalidationService {
  private readonly logger = new Logger(RevalidationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a store id to its slug, then revalidate. No-op if not found. */
  async revalidateStoreById(storeId: string): Promise<void> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { slug: true },
    });
    if (store?.slug) {
      await this.revalidateStoreBySlug(store.slug);
    }
  }

  /** Resolve a creator's (1:1) store slug, then revalidate. No-op if none. */
  async revalidateStoreByCreatorId(creatorId: string): Promise<void> {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { slug: true },
    });
    if (store?.slug) {
      await this.revalidateStoreBySlug(store.slug);
    }
  }

  /**
   * Slugs of every store that sells a provider product (its CustomProduct
   * rows). Read this BEFORE a delete, when the rows still exist.
   */
  async storeSlugsByBaseProductId(productId: string): Promise<string[]> {
    const rows = await this.prisma.customProduct.findMany({
      where: { product_id: productId },
      select: { creator_id: true },
      distinct: ['creator_id'],
    });
    if (!rows.length) return [];
    const stores = await this.prisma.store.findMany({
      where: { creator_id: { in: rows.map((r) => r.creator_id) } },
      select: { slug: true },
    });
    return stores.map((s) => s.slug).filter((s): s is string => !!s);
  }

  /**
   * A provider changed a base product (images, videos, texts): refresh every
   * reselling store, so a removed video does not stay on them for the
   * time-based fallback window.
   */
  async revalidateStoresByBaseProductId(productId: string): Promise<void> {
    await this.revalidateStoreSlugs(
      await this.storeSlugsByBaseProductId(productId),
    );
  }

  /** Revalidate several stores, a few requests at a time. */
  async revalidateStoreSlugs(slugs: string[]): Promise<void> {
    const unique = [...new Set(slugs)];
    for (let i = 0; i < unique.length; i += 10) {
      await Promise.all(
        unique.slice(i, i + 10).map((slug) => this.revalidateStoreBySlug(slug)),
      );
    }
  }

  /** POST the store slug to the storefront's /api/revalidate endpoint. */
  async revalidateStoreBySlug(slug: string): Promise<void> {
    await this.post({ slug }, `store "${slug}"`);
  }

  /**
   * Purge a platform-wide storefront cache tag (e.g. `legal` after an admin
   * edits a legal page). The storefront only accepts an allow-listed set.
   */
  async revalidateTag(tag: string): Promise<void> {
    await this.post({ tag }, `tag "${tag}"`);
  }

  private async post(
    body: Record<string, string>,
    label: string,
  ): Promise<void> {
    const baseUrl = process.env.STOREFRONT_URL;
    const secret = process.env.REVALIDATE_SECRET;

    if (!baseUrl || !secret) {
      this.logger.warn(
        'STOREFRONT_URL or REVALIDATE_SECRET not set — skipping revalidation',
      );
      return;
    }

    try {
      const res = await fetch(`${baseUrl}/api/revalidate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-revalidate-secret': secret,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.logger.warn(
          `Revalidation for ${label} returned ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Revalidation request for ${label} failed: ${(err as Error).message}`,
      );
    }
  }
}
