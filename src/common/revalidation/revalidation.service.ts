import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Trailing debounce of calls for one slug / tag (a bulk action = one POST). */
const DEBOUNCE_MS = 300;
/** A steady stream of calls still sends at least this often. */
const DEBOUNCE_MAX_WAIT_MS = 2000;
/**
 * Wait before each attempt: at once, then after 1 s, 5 s and 30 s. The last
 * step outlasts a storefront restart (a deploy answers 502 for longer than
 * the first three attempts take).
 */
const ATTEMPT_DELAYS_MS = [0, 1000, 5000, 30_000];
/** Attempts of a send the caller waits for (manual flush). */
const WAITED_ATTEMPTS = 2;
/** One attempt may not hang longer than this. */
const REQUEST_TIMEOUT_MS = 10_000;
/** POSTs in flight at the same time (many reselling stores of one product). */
const MAX_CONCURRENT = 10;
/** Longest a flush (shutdown, script exit) waits for deliveries in flight. */
const FLUSH_WAIT_MS = 5000;

interface PendingSend {
  key: string;
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
  /** Keys waiting in `queue`: one slug is queued once. */
  private readonly queued = new Set<string>();
  /** Deliveries that were started and have not settled yet. */
  private readonly inFlight = new Set<Promise<void>>();
  private active = 0;
  /** Set at shutdown: nothing is debounced any more. */
  private closing = false;

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

  /**
   * Revalidate one store now and wait for the outcome (the manual "flush
   * cache" action answers after the POST). No debounce; a send for the same
   * slug that was still waiting is replaced by this one. Never rejects.
   */
  async revalidateStoreBySlugNow(slug: string): Promise<void> {
    const key = `slug:${slug}`;
    const waiting = this.pending.get(key);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.pending.delete(key);
    }
    await this.start({ slug }, `store "${slug}"`, WAITED_ATTEMPTS);
  }

  /**
   * Send everything that is still waiting (debounce window and queue) now,
   * one attempt each, and wait for all deliveries in flight, at most
   * `maxWaitMs`. For a caller that is about to exit: the shutdown hook, or a
   * script that uses this service outside Nest (the debounce timer is
   * unref'd and would never fire there).
   */
  async flush(maxWaitMs = FLUSH_WAIT_MS): Promise<void> {
    const waiting = [...this.pending.values(), ...this.queue.splice(0)];
    this.pending.clear();
    this.queued.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      void this.start(entry.body, entry.label, 1);
    }
    if (!this.inFlight.size) return;
    let cap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.inFlight]),
      new Promise<void>((resolve) => {
        cap = setTimeout(resolve, maxWaitMs);
      }),
    ]);
    clearTimeout(cap);
  }

  /**
   * Shutdown: send what is waiting and give the deliveries in flight a few
   * seconds. A mutation that finishes after this point is sent at once.
   */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await this.flush();
  }

  /** Trailing debounce per key; never throws into the caller. */
  private schedule(
    key: string,
    body: Record<string, string>,
    label: string,
  ): void {
    try {
      if (this.closing) {
        // No timer would fire any more: send now, once.
        void this.start(body, label, 1);
        return;
      }
      const now = Date.now();
      let entry = this.pending.get(key);
      if (entry) clearTimeout(entry.timer);
      else {
        entry = { key, body, label, firstAt: now };
        this.pending.set(key, entry);
      }
      const wait = Math.max(
        0,
        Math.min(DEBOUNCE_MS, entry.firstAt + DEBOUNCE_MAX_WAIT_MS - now),
      );
      entry.timer = setTimeout(() => this.enqueue(key), wait);
      // A waiting revalidation must not keep the process alive.
      entry.timer.unref?.();
    } catch (err) {
      this.logger.warn(`Revalidation for ${label} not sent: ${reason(err)}`);
    }
  }

  /** The debounce window of `key` ended: hand it to the sender. */
  private enqueue(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    // Already waiting for a slot: that send covers this call too.
    if (!this.queued.has(key)) {
      this.queued.add(key);
      this.queue.push(entry);
    }
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const job = this.queue.shift() as PendingSend;
      this.queued.delete(job.key);
      this.active++;
      void this.start(job.body, job.label).then(() => {
        this.active--;
        this.drain();
      });
    }
  }

  /** Start one delivery and track it until it settles. Never rejects. */
  private start(
    body: Record<string, string>,
    label: string,
    maxAttempts?: number,
  ): Promise<void> {
    const run = this.deliver(body, label, maxAttempts)
      .catch((err) => {
        this.logger.warn(`Revalidation for ${label} not sent: ${reason(err)}`);
      })
      .finally(() => {
        this.inFlight.delete(run);
      });
    this.inFlight.add(run);
    return run;
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
        // Release the connection: the answer's body is never read.
        await res.body?.cancel().catch(() => undefined);
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
