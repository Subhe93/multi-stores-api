import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Trailing debounce of calls for one slug / tag (a bulk action = one POST). */
const DEBOUNCE_MS = 300;
/** A steady stream of calls still sends at least this often. */
const DEBOUNCE_MAX_WAIT_MS = 2000;
/** Wait before each attempt: at once, then after 1 s, then after 5 s. */
const ATTEMPT_DELAYS_MS = [0, 1000, 5000];
/** One attempt may not hang longer than this. */
const REQUEST_TIMEOUT_MS = 10_000;
/** POSTs in flight at the same time (many reselling stores of one product). */
const MAX_CONCURRENT = 10;

interface PendingSend {
  body: Record<string, string>;
  label: string;
  firstAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Tells the storefront (Next.js) to drop its cached data for a store after a
 * mutation, so creators see published changes within seconds. Fire-and-forget:
 * the public methods only schedule the request and return, and a failed
 * revalidation must never break the originating mutation. Delivery is
 * debounced per slug, retried a few times and, when it still fails, logged
 * once (the time-based revalidate fallback on the web side then catches up
 * for changed data; a deleted resource stays cached until the next call).
 */
@Injectable()
export class RevalidationService implements OnModuleDestroy {
  private readonly logger = new Logger(RevalidationService.name);
  private readonly pending = new Map<string, PendingSend>();
  private readonly queue: PendingSend[] = [];
  private active = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a store id to its slug, then revalidate. No-op if not found. */
  async revalidateStoreById(storeId: string): Promise<void> {
    try {
      const store = await this.prisma.store.findUnique({
        where: { id: storeId },
        select: { slug: true },
      });
      if (store?.slug) {
        await this.revalidateStoreBySlug(store.slug);
      }
    } catch (err) {
      // The mutation is already committed: never turn it into an error.
      this.logger.warn(
        `Revalidation lookup for store id "${storeId}" failed: ${reason(err)}`,
      );
    }
  }

  /** Resolve a creator's (1:1) store slug, then revalidate. No-op if none. */
  async revalidateStoreByCreatorId(creatorId: string): Promise<void> {
    try {
      const store = await this.prisma.store.findUnique({
        where: { creator_id: creatorId },
        select: { slug: true },
      });
      if (store?.slug) {
        await this.revalidateStoreBySlug(store.slug);
      }
    } catch (err) {
      this.logger.warn(
        `Revalidation lookup for creator id "${creatorId}" failed: ${reason(err)}`,
      );
    }
  }

  /**
   * Slugs of every store that sells a provider product (its CustomProduct
   * rows). Read this BEFORE a delete, when the rows still exist. A failed
   * lookup is logged and answers no slugs.
   */
  async storeSlugsByBaseProductId(productId: string): Promise<string[]> {
    try {
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
    } catch (err) {
      this.logger.warn(
        `Revalidation lookup for base product "${productId}" failed: ${reason(err)}`,
      );
      return [];
    }
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

  /**
   * Refresh the stores that show a product: the creator's own store, or, for
   * a provider product, every store reselling it (CustomProduct base).
   */
  async revalidateStoresOfProduct(product: {
    id: string;
    creator_id: string | null;
    provider_id: string | null;
  }): Promise<void> {
    if (product.creator_id) {
      await this.revalidateStoreByCreatorId(product.creator_id);
    } else if (product.provider_id) {
      await this.revalidateStoresByBaseProductId(product.id);
    }
  }

  /** Revalidate several stores (sent a few requests at a time). */
  async revalidateStoreSlugs(slugs: string[]): Promise<void> {
    const unique = [...new Set(slugs)];
    for (let i = 0; i < unique.length; i += 10) {
      await Promise.all(
        unique.slice(i, i + 10).map((slug) => this.revalidateStoreBySlug(slug)),
      );
    }
  }

  /**
   * POST the store slug to the storefront's /api/revalidate endpoint. Only
   * schedules the request: calls for one slug within a short window are
   * sent as one POST, in the background.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async revalidateStoreBySlug(slug: string): Promise<void> {
    this.schedule(`slug:${slug}`, { slug }, `store "${slug}"`);
  }

  /**
   * Purge a platform-wide storefront cache tag (e.g. `legal` after an admin
   * edits a legal page). The storefront only accepts an allow-listed set.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async revalidateTag(tag: string): Promise<void> {
    this.schedule(`tag:${tag}`, { tag }, `tag "${tag}"`);
  }

  /** Shutdown: send what is still waiting in the debounce window, once. */
  async onModuleDestroy(): Promise<void> {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) clearTimeout(entry.timer);
    await Promise.all(waiting.map((e) => this.deliver(e.body, e.label, 1)));
  }

  /** Trailing debounce per key; never throws into the caller. */
  private schedule(
    key: string,
    body: Record<string, string>,
    label: string,
  ): void {
    try {
      const now = Date.now();
      let entry = this.pending.get(key);
      if (entry) clearTimeout(entry.timer);
      else {
        entry = { body, label, firstAt: now };
        this.pending.set(key, entry);
      }
      const wait = Math.max(
        0,
        Math.min(DEBOUNCE_MS, entry.firstAt + DEBOUNCE_MAX_WAIT_MS - now),
      );
      entry.timer = setTimeout(() => this.flush(key), wait);
      // A waiting revalidation must not keep the process alive.
      entry.timer.unref?.();
    } catch (err) {
      this.logger.warn(`Revalidation for ${label} not sent: ${reason(err)}`);
    }
  }

  private flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.queue.push(entry);
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const job = this.queue.shift() as PendingSend;
      this.active++;
      void this.deliver(job.body, job.label).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  /**
   * POST with retries. Network errors, timeouts and 408 / 429 / 5xx answers
   * are retried; another 4xx (e.g. a wrong secret) is final at once. One
   * warning per final failure; never rejects.
   */
  private async deliver(
    body: Record<string, string>,
    label: string,
    maxAttempts = ATTEMPT_DELAYS_MS.length,
  ): Promise<void> {
    const baseUrl = process.env.STOREFRONT_URL;
    const secret = process.env.REVALIDATE_SECRET;

    if (!baseUrl || !secret) {
      this.logger.warn(
        'STOREFRONT_URL or REVALIDATE_SECRET not set — skipping revalidation',
      );
      return;
    }

    let failure = '';
    let attempts = 0;
    for (; attempts < maxAttempts; ) {
      const delay = ATTEMPT_DELAYS_MS[attempts];
      if (delay > 0) await sleep(delay);
      attempts++;
      try {
        const res = await fetch(`${baseUrl}/api/revalidate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-revalidate-secret': secret,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.ok) return;
        failure = `returned ${res.status} ${res.statusText}`;
        if (!isRetryableStatus(res.status)) break;
      } catch (err) {
        failure = `request failed: ${reason(err)}`;
      }
    }
    this.logger.warn(
      `Revalidation for ${label} failed after ${attempts} attempt(s): ${failure}`,
    );
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
