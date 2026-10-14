import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dns from 'node:dns/promises';
import { StoreDomainStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  isReservedDomain,
  isValidHostname,
  normalizeHostname,
} from '../../common/domains/reserved-hosts';
import { MarketsContextService } from './markets-context.service';
import type { DomainView } from './market.types';

/** The DNS lookups the verify step needs (injectable for tests). */
export interface DnsResolver {
  resolveCname(host: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
}

export const DNS_RESOLVER = 'MARKETS_DNS_RESOLVER';

const DNS_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const nodeResolver: DnsResolver = {
  resolveCname: (host) => dns.resolveCname(host),
  resolve4: (host) => dns.resolve4(host),
};

const MARKET_DOMAIN_NOT_FOUND = {
  code: 'MARKET_DOMAIN_NOT_FOUND',
  message: 'Domain not found',
};

/**
 * Hostnames of a market. Lifecycle (M1-DESIGN L6): the creator adds a host
 * (PENDING), "Verify" checks its CNAME/A record against the platform's DNS
 * target (VERIFIED), and an admin sets ACTIVE after the CDN step. Only ACTIVE
 * hosts are served, matched by CORS or used as link origins.
 */
@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly revalidation: RevalidationService,
    private readonly markets: MarketsContextService,
    @Optional() @Inject(DNS_RESOLVER) private readonly resolver?: DnsResolver,
  ) {}

  /** What the creator must point their DNS at. */
  dnsTarget(): { cname: string | null; a?: string } {
    const cname = (
      this.config.get<string>('CUSTOM_DOMAIN_CNAME_TARGET') || ''
    ).trim();
    const a = (this.config.get<string>('CUSTOM_DOMAIN_A_TARGET') || '').trim();
    return { cname: cname || null, ...(a ? { a } : {}) };
  }

  /** Admin: every domain of a creator's store, across its markets. */
  async adminListByCreator(creatorId: string): Promise<DomainView[]> {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { id: true },
    });
    if (!store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    const rows = await this.prisma.storeDomain.findMany({
      where: { store_id: store.id },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async listForMarket(marketId: string): Promise<DomainView[]> {
    const rows = await this.prisma.storeDomain.findMany({
      where: { market_id: marketId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async add(
    storeId: string,
    marketId: string,
    dto: { hostname: string; redirect_to?: string | null },
  ): Promise<DomainView> {
    const hostname = normalizeHostname(dto.hostname);
    if (!isValidHostname(hostname)) {
      throw new BadRequestException({
        code: 'MARKET_DOMAIN_INVALID',
        message: 'hostname must be a valid domain like shop.example.com',
      });
    }
    if (isReservedDomain(hostname)) {
      throw new BadRequestException({
        code: 'MARKET_DOMAIN_RESERVED',
        message: 'This domain is reserved by the platform',
      });
    }
    await this.assertNotTaken(hostname);
    const redirectTo = dto.redirect_to
      ? normalizeHostname(dto.redirect_to)
      : null;
    if (redirectTo) await this.assertRedirectTarget(marketId, redirectTo);

    const existingCount = await this.prisma.storeDomain.count({
      where: { market_id: marketId },
    });
    const row = await this.prisma.storeDomain.create({
      data: {
        store_id: storeId,
        market_id: marketId,
        hostname,
        // The first host of a market is its canonical one; a redirecting
        // host (www → apex) never is.
        is_primary: existingCount === 0 && !redirectTo,
        redirect_to: redirectTo,
      },
    });
    await this.afterMutation(storeId);
    return this.toView(row);
  }

  async remove(storeId: string, marketId: string, domainId: string) {
    const row = await this.rowOf(marketId, domainId);
    // The canonical host of a live market is what serves it: set another
    // primary (or draft the market) before removing it.
    if (row.is_primary && row.status === 'ACTIVE' && !row.redirect_to) {
      const market = await this.prisma.market.findUnique({
        where: { id: marketId },
        select: { status: true, is_default: true },
      });
      if (market && market.status === 'LIVE' && !market.is_default) {
        throw new BadRequestException({
          code: 'MARKET_DOMAIN_IN_USE',
          message:
            'This is the primary host of a live market. Make another host primary or set the market to draft first.',
        });
      }
    }
    await this.prisma.storeDomain.delete({ where: { id: row.id } });
    await this.afterMutation(storeId);
    return { deleted: true };
  }

  /**
   * DNS check: the host's CNAME must point at the platform target, or its A
   * records must include the platform address. Success → VERIFIED (an ACTIVE
   * host stays ACTIVE); failure → 400 MARKET_DOMAIN_VERIFY_FAILED with what
   * was observed.
   */
  async verify(
    storeId: string,
    marketId: string,
    domainId: string,
  ): Promise<DomainView> {
    const row = await this.rowOf(marketId, domainId);
    const target = this.dnsTarget();
    const observed = await this.lookup(row.hostname);
    const seen = [...observed.cname, ...observed.a];
    const cnameTarget = target.cname;
    const ok =
      (cnameTarget && observed.cname.some((c) => sameHost(c, cnameTarget))) ||
      (target.a && observed.a.includes(target.a));
    if (!ok) {
      // Keep what was seen so the dashboard can show it on the next load.
      await this.prisma.storeDomain.update({
        where: { id: row.id },
        data: { last_observed: seen },
      });
      throw new BadRequestException({
        code: 'MARKET_DOMAIN_VERIFY_FAILED',
        message: `${row.hostname} does not point at ${cnameTarget || target.a || 'the platform'} yet.`,
        observed: seen,
      });
    }
    const updated = await this.prisma.storeDomain.update({
      where: { id: row.id },
      data: {
        verified_at: new Date(),
        last_observed: seen,
        ...(row.status === StoreDomainStatus.PENDING
          ? { status: StoreDomainStatus.VERIFIED }
          : {}),
      },
    });
    await this.afterMutation(storeId);
    return this.toView(updated, seen);
  }

  async setPrimary(
    storeId: string,
    marketId: string,
    domainId: string,
  ): Promise<DomainView> {
    const row = await this.rowOf(marketId, domainId);
    if (row.redirect_to) {
      throw new BadRequestException({
        code: 'MARKET_DOMAIN_REDIRECT_INVALID',
        message: 'A redirecting host cannot be the primary host',
      });
    }
    await this.prisma.$transaction([
      this.prisma.storeDomain.updateMany({
        where: { market_id: marketId },
        data: { is_primary: false },
      }),
      this.prisma.storeDomain.update({
        where: { id: row.id },
        data: { is_primary: true },
      }),
    ]);
    await this.afterMutation(storeId);
    return this.toView({ ...row, is_primary: true });
  }

  /** Admin: PENDING / VERIFIED / ACTIVE (L6 — ACTIVE after the CDN step). */
  async adminSetStatus(
    domainId: string,
    status: StoreDomainStatus,
  ): Promise<DomainView> {
    const row = await this.prisma.storeDomain.findUnique({
      where: { id: domainId },
    });
    if (!row) throw new NotFoundException(MARKET_DOMAIN_NOT_FOUND);
    const updated = await this.prisma.storeDomain.update({
      where: { id: row.id },
      data: {
        status,
        ...(status !== StoreDomainStatus.PENDING && !row.verified_at
          ? { verified_at: new Date() }
          : {}),
      },
    });
    await this.afterMutation(row.store_id);
    return this.toView(updated);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async rowOf(marketId: string, domainId: string) {
    const row = await this.prisma.storeDomain.findFirst({
      where: { id: domainId, market_id: marketId },
    });
    if (!row) throw new NotFoundException(MARKET_DOMAIN_NOT_FOUND);
    return row;
  }

  /** Taken by any StoreDomain row or any store's legacy custom_domain. */
  private async assertNotTaken(hostname: string): Promise<void> {
    const [domain, store] = await Promise.all([
      this.prisma.storeDomain.findUnique({
        where: { hostname },
        select: { id: true },
      }),
      this.prisma.store.findFirst({
        where: { custom_domain: { equals: hostname, mode: 'insensitive' } },
        select: { id: true },
      }),
    ]);
    if (domain || store) {
      throw new ConflictException({
        code: 'MARKET_DOMAIN_TAKEN',
        message: 'This domain is already in use',
      });
    }
  }

  /**
   * redirect_to must name another, non-redirecting host of the same market.
   * The target's own status is not checked: a www host may be registered
   * before the apex is verified; it only serves once both are ACTIVE.
   */
  private async assertRedirectTarget(
    marketId: string,
    redirectTo: string,
  ): Promise<void> {
    const target = await this.prisma.storeDomain.findFirst({
      where: { market_id: marketId, hostname: redirectTo },
      select: { id: true, redirect_to: true },
    });
    if (!target || target.redirect_to) {
      throw new BadRequestException({
        code: 'MARKET_DOMAIN_REDIRECT_INVALID',
        message:
          'redirect_to must be a non-redirecting hostname of this market',
      });
    }
  }

  /**
   * CNAME and A lookups, each bounded by CUSTOM_DOMAIN_DNS_TIMEOUT_MS
   * (default 5 s): a hanging resolver counts as "nothing observed", i.e. a
   * verify failure, never a hung request.
   */
  private async lookup(
    host: string,
  ): Promise<{ cname: string[]; a: string[] }> {
    const resolver = this.resolver ?? nodeResolver;
    const timeoutMs =
      Number(this.config.get<string>('CUSTOM_DOMAIN_DNS_TIMEOUT_MS')) ||
      DNS_TIMEOUT_MS;
    const bounded = (p: Promise<string[]>) =>
      withTimeout(p, timeoutMs).catch(() => [] as string[]);
    const cname = await bounded(resolver.resolveCname(host));
    const a = await bounded(resolver.resolve4(host));
    return { cname, a };
  }

  private async afterMutation(storeId: string): Promise<void> {
    this.markets.invalidate(storeId);
    await this.revalidation.revalidateStoreById(storeId);
  }

  toView(
    row: {
      id: string;
      hostname: string;
      is_primary: boolean;
      redirect_to: string | null;
      status: StoreDomainStatus;
      verified_at: Date | null;
      last_observed?: unknown;
    },
    observed: string[] | null = null,
  ): DomainView {
    return {
      id: row.id,
      hostname: row.hostname,
      is_primary: row.is_primary,
      redirect_to: row.redirect_to,
      status: row.status,
      verified_at: row.verified_at ? row.verified_at.toISOString() : null,
      dns: {
        expected_cname: this.dnsTarget().cname,
        // Fresh records from this call, else what the last verify saw.
        observed: observed ?? observedOf(row.last_observed),
      },
    };
  }
}

function observedOf(raw: unknown): string[] | null {
  return Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : null;
}

function sameHost(a: string, b: string): boolean {
  return normalizeHostname(a) === normalizeHostname(b);
}
