import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { SUPPORTED_LOCALES } from '../markets/market.types';
import { loadPublicHost } from '../stores/storefront-hosts';

/** Store context resolved from a storefront request (store_slug / hostname). */
export interface StoreLinkContext {
  id: string;
  slug: string;
  name: string;
  primaryLocale: string | null;
  isActive: boolean;
  /**
   * Public origin of the store (no trailing slash): the ACTIVE market host
   * the request came from, else the store's public host (storefront-hosts:
   * default market primary with the markets app, else the custom domain),
   * else the slug subdomain.
   * Null when the store is inactive (links then fall back to the platform).
   */
  base: string | null;
}

export interface AccountLinks {
  magicUrl: string;
  loginUrl: string;
}

const DEFAULT_STOREFRONT_URL = 'http://localhost:3003';
const DEFAULT_DASHBOARD_URL = 'http://localhost:3002';

/** A locale that is safe to put in a platform path, else 'en'. */
export function safeLocale(locale?: string | null): string {
  const l = (locale ?? '').trim().toLowerCase();
  return (SUPPORTED_LOCALES as readonly string[]).includes(l) ? l : 'en';
}

/**
 * Builds the links of account emails (password reset, magic login, login).
 * Store domains are derived server-side from the DB, never from raw client
 * input, so none of these links can be turned into an open redirect.
 */
@Injectable()
export class AccountLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storeApps: StoreAppsService,
  ) {}

  storefrontUrl(): string {
    return (
      this.config.get<string>('STOREFRONT_URL') || DEFAULT_STOREFRONT_URL
    ).replace(/\/$/, '');
  }

  dashboardUrl(): string {
    return (
      this.config.get<string>('DASHBOARD_URL') || DEFAULT_DASHBOARD_URL
    ).replace(/\/$/, '');
  }

  /**
   * The store a storefront request came from. `hostname` (markets app) is
   * honoured only when it is one of the store's ACTIVE hostnames.
   */
  async resolveStore(
    storeSlug?: string | null,
    hostname?: string | null,
  ): Promise<StoreLinkContext | null> {
    if (!storeSlug) return null;
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      select: {
        id: true,
        slug: true,
        name: true,
        custom_domain: true,
        is_active: true,
        language_config: { select: { primary_locale: true } },
      },
    });
    if (!store) return null;
    return {
      id: store.id,
      slug: store.slug,
      name: store.name,
      primaryLocale: store.language_config?.primary_locale ?? null,
      isActive: store.is_active,
      base: store.is_active ? await this.storeOrigin(store, hostname) : null,
    };
  }

  /**
   * Store context of an auth request (login, register, guest-register,
   * forgot-password) that decides WHICH account is meant: customers belong
   * to exactly one store, staff to none.
   *
   * - Neither `store_slug` nor `hostname`: null (staff / platform context).
   * - `store_slug`: that store (active or not), else 400 STORE_NOT_FOUND.
   *   The `hostname` never changes which store is meant; like resolveStore
   *   it only picks the origin of emailed links when it is one of the
   *   store's ACTIVE hosts, and is ignored otherwise (platform host, slug
   *   subdomain, localhost, a foreign host).
   * - `hostname` alone: the store owning that ACTIVE domain, else 400
   *   STORE_NOT_FOUND.
   *
   * The 400 never depends on accounts, so it reveals nothing about emails.
   */
  async resolveRequestStore(
    storeSlug?: string | null,
    hostname?: string | null,
  ): Promise<StoreLinkContext | null> {
    const slug = storeSlug?.trim() || null;
    const host = hostname?.trim().toLowerCase().split(':')[0] || null;
    if (!slug && !host) return null;

    let store: StoreLinkContext | null = null;
    if (slug) {
      store = await this.resolveStore(slug, host);
    } else if (host) {
      const domain = await this.prisma.storeDomain.findFirst({
        where: { hostname: host, status: 'ACTIVE' },
        select: { store: { select: { slug: true } } },
      });
      if (domain) store = await this.resolveStore(domain.store.slug, host);
    }
    if (!store) {
      throw new BadRequestException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return store;
  }

  private async storeOrigin(
    store: { id: string; slug: string; custom_domain: string | null },
    hostname?: string | null,
  ): Promise<string | null> {
    // Markets app: keep the customer on the market host they came from,
    // provided it is one of the store's ACTIVE hostnames.
    const host = hostname?.trim().toLowerCase().split(':')[0];
    if (host && (await this.storeApps.isEnabled(store.id, 'markets'))) {
      const domain = await this.prisma.storeDomain.findFirst({
        where: { store_id: store.id, hostname: host, status: 'ACTIVE' },
        select: { id: true },
      });
      if (domain) return `https://${host}`;
    }
    // Otherwise the store's canonical public host (a market store's legacy
    // custom_domain may be a retired host).
    const publicHost = await loadPublicHost(
      { prisma: this.prisma, storeApps: this.storeApps },
      store,
    );
    if (publicHost) return `https://${publicHost}`;
    try {
      const url = new URL(this.storefrontUrl());
      return `${url.protocol}//${store.slug}.${url.host}`;
    } catch {
      // Malformed base URL: callers fall back to the platform link.
      return null;
    }
  }

  /**
   * A storefront page link: on the store origin when there is one, else on
   * the platform storefront [locale] tree.
   */
  storefrontLink(
    storeBase: string | null | undefined,
    path: string,
    query?: string,
    locale?: string | null,
  ): string {
    const q = query ? `?${query}` : '';
    if (storeBase) return `${storeBase.replace(/\/$/, '')}${path}${q}`;
    return `${this.storefrontUrl()}/${safeLocale(locale)}${path}${q}`;
  }

  /**
   * Magic-login and login links for an account. Customers go to the store
   * they came from (or the platform storefront); creators, providers and
   * admins go to the dashboard.
   *
   * The token travels in the URL fragment (`#token=`), which browsers never
   * send to the server: it stays out of nginx / Next access logs, CDN logs
   * and Referer headers. The pages still accept `?token=` for links mailed
   * before this change.
   */
  accountLinks(
    rawToken: string,
    opts: {
      role: UserRole;
      storeBase?: string | null;
      locale?: string | null;
    },
  ): AccountLinks {
    const fragment = `#token=${encodeURIComponent(rawToken)}`;
    if (opts.role === UserRole.CUSTOMER) {
      return {
        magicUrl: `${this.storefrontLink(
          opts.storeBase,
          '/auth/magic',
          undefined,
          opts.locale,
        )}${fragment}`,
        loginUrl: this.storefrontLink(
          opts.storeBase,
          '/auth/login',
          undefined,
          opts.locale,
        ),
      };
    }
    const dashboard = this.dashboardUrl();
    return {
      magicUrl: `${dashboard}/auth/magic${fragment}`,
      loginUrl: `${dashboard}/auth/login`,
    };
  }
}
