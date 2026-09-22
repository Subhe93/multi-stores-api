import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { originHostname } from './cors-origin.matcher';

/** Positive and negative store-domain answers are both kept this long. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound on cached hostnames so random Origin headers cannot grow memory. */
const CACHE_MAX_ENTRIES = 2000;

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
}

/**
 * Resolves request origins that are not in CORS_ALLOWED_ORIGINS against the
 * stores' custom domains, so a creator-owned storefront domain is accepted
 * without redeploying the API. Results (hits and misses) are cached in
 * memory for five minutes.
 */
@Injectable()
export class CorsOriginService {
  private readonly logger = new Logger(CorsOriginService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * True when the origin's hostname equals a store's custom_domain
   * (case-insensitive). "www." is treated as equivalent in both directions:
   * an origin "www.shop.com" matches a store registered as "shop.com" and
   * vice versa.
   */
  async isStoreOrigin(origin: string): Promise<boolean> {
    const host = originHostname(origin);
    if (!host) return false;

    const now = Date.now();
    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > now) return cached.allowed;

    let allowed = false;
    try {
      const candidates = new Set<string>([host]);
      if (host.startsWith('www.')) candidates.add(host.slice(4));
      else candidates.add(`www.${host}`);
      const store = await this.prisma.store.findFirst({
        where: {
          OR: [...candidates].map((domain) => ({
            custom_domain: { equals: domain, mode: 'insensitive' as const },
          })),
        },
        select: { id: true },
      });
      allowed = store !== null;
    } catch (err) {
      // A DB hiccup must not turn into a cached "denied" for five minutes:
      // answer no for this request only.
      this.logger.warn(
        `Custom-domain lookup failed for origin ${origin}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }

    this.remember(host, allowed, now);
    return allowed;
  }

  private remember(host: string, allowed: boolean, now: number): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Drop expired entries first; if still full, evict the oldest inserted.
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        for (const key of this.cache.keys()) {
          this.cache.delete(key);
          break;
        }
      }
    }
    this.cache.set(host, { allowed, expiresAt: now + CACHE_TTL_MS });
  }
}
