import { platformHosts } from '../domains/platform-hosts';

/** The two reads the host list needs (PrismaService satisfies it). */
export interface StoreCaptchaHostsClient {
  storeDomain: {
    findMany(args: {
      where: { store_id: string; status: 'ACTIVE' };
      select: { hostname: true };
    }): PromiseLike<{ hostname: string }[]>;
  };
  store: {
    findUnique(args: {
      where: { id: string };
      select: { custom_domain: true };
    }): PromiseLike<{ custom_domain: string | null } | null>;
  };
}

/**
 * Hosts a storefront captcha may be solved on: the store's slug subdomain
 * under any platform host, its ACTIVE market domains and its legacy custom
 * domain. Shared by the customer auth forms and the review form; callers
 * only read it when TURNSTILE_CUSTOMERS is on.
 */
export async function storeCaptchaHosts(
  prisma: StoreCaptchaHostsClient,
  storeId: string,
): Promise<string[]> {
  const [domains, store] = await Promise.all([
    prisma.storeDomain.findMany({
      where: { store_id: storeId, status: 'ACTIVE' },
      select: { hostname: true },
    }),
    prisma.store.findUnique({
      where: { id: storeId },
      select: { custom_domain: true },
    }),
  ]);
  return [
    ...platformHosts().map((h) => `.${h}`),
    ...domains.map((d) => d.hostname),
    ...(store?.custom_domain ? [store.custom_domain] : []),
  ];
}
