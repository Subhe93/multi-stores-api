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

  /** POST the store slug to the storefront's /api/revalidate endpoint. */
  async revalidateStoreBySlug(slug: string): Promise<void> {
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
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        this.logger.warn(
          `Revalidation for "${slug}" returned ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Revalidation request for "${slug}" failed: ${(err as Error).message}`,
      );
    }
  }
}
