// Public host(s) of a store for links built outside the storefront (the
// dashboard's "Visit store" / "View in store", the owner edit hand-off).
// Mirrors what the storefront proxy serves (stores.service lookupCustomDomain):
// with the markets app on, a StoreDomain host is served when it is ACTIVE and
// its market LIVE; with the app off only the legacy custom_domain is served.

import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';

export interface StorefrontDomainRow {
  hostname: string;
  is_primary: boolean;
  redirect_to: string | null;
  status: 'PENDING' | 'VERIFIED' | 'ACTIVE';
  market: { is_default: boolean; status: 'DRAFT' | 'LIVE' };
}

export interface StorefrontHosts {
  /** Canonical public host (no scheme), or null = platform subdomain. */
  public_host: string | null;
  /** Every host that serves this storefront (lower-case, deduplicated). */
  storefront_hosts: string[];
}

const norm = (host: string) => host.trim().toLowerCase().replace(/\.$/, '');

/** Canonical host of a group of servable rows: primary first, else the first one. */
function canonicalOf(rows: StorefrontDomainRow[]): string | null {
  const canonical = rows.filter((d) => !d.redirect_to);
  const pick = canonical.find((d) => d.is_primary) ?? canonical[0];
  return pick ? norm(pick.hostname) : null;
}

export function computeStorefrontHosts(
  customDomain: string | null | undefined,
  domains: StorefrontDomainRow[],
  marketsEnabled: boolean,
): StorefrontHosts {
  const custom = customDomain ? norm(customDomain) : null;
  const live = marketsEnabled
    ? domains.filter((d) => d.status === 'ACTIVE' && d.market.status === 'LIVE')
    : [];

  // Default market's canonical host, else the primary of any live market.
  const publicHost =
    canonicalOf(live.filter((d) => d.market.is_default)) ??
    (() => {
      const primary = live.find((d) => d.is_primary && !d.redirect_to);
      return primary ? norm(primary.hostname) : null;
    })() ??
    custom;

  const hosts = new Set<string>();
  for (const d of live) {
    hosts.add(norm(d.hostname));
    if (d.redirect_to) hosts.add(norm(d.redirect_to));
  }
  if (custom) hosts.add(custom);

  return { public_host: publicHost, storefront_hosts: [...hosts] };
}

/** Prisma / StoreApps surface the loader needs. */
export interface StorefrontHostsDeps {
  prisma: Pick<PrismaService, 'storeDomain'>;
  storeApps: Pick<StoreAppsService, 'isEnabled'>;
}

/** Reads the store's domains and computes its public host(s). */
export async function loadStorefrontHosts(
  deps: StorefrontHostsDeps,
  store: { id: string; custom_domain: string | null },
): Promise<StorefrontHosts> {
  const marketsEnabled = await deps.storeApps
    .isEnabled(store.id, 'markets')
    .catch(() => false);
  const domains = marketsEnabled
    ? await deps.prisma.storeDomain.findMany({
        where: { store_id: store.id },
        select: {
          hostname: true,
          is_primary: true,
          redirect_to: true,
          status: true,
          market: { select: { is_default: true, status: true } },
        },
        orderBy: { created_at: 'asc' },
      })
    : [];
  return computeStorefrontHosts(store.custom_domain, domains, marketsEnabled);
}

/**
 * Canonical public host of a store for customer-facing links (emails, Kustom
 * merchant URLs, account links), or null when callers should fall back to the
 * slug subdomain / platform URL. Same rule as the dashboard links: markets
 * app off -> legacy custom_domain; on -> default LIVE market's primary host,
 * custom_domain only as a fallback. Without a StoreAppsService (lean unit
 * wiring) the markets app is treated as off.
 */
export async function loadPublicHost(
  deps: {
    prisma: StorefrontHostsDeps['prisma'];
    storeApps?: StorefrontHostsDeps['storeApps'] | null;
  },
  store: { id: string; custom_domain: string | null },
): Promise<string | null> {
  if (!deps.storeApps) {
    return computeStorefrontHosts(store.custom_domain, [], false).public_host;
  }
  const { public_host } = await loadStorefrontHosts(
    { prisma: deps.prisma, storeApps: deps.storeApps },
    store,
  );
  return public_host;
}
