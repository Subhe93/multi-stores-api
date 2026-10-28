import type { PrismaService } from '../../../prisma/prisma.service';

/** Platform legal page every storefront mirrors (the pre-Phase-3 default). */
export const PLATFORM_TERMS_PATH = '/legal/terms';

/**
 * Path of the store's own terms page, when it has a published one: a builder
 * STATIC page of kind TERMS, else a legacy static page of type TERMS. Both are
 * served at `/<slug>` on the storefront. Null means "use the platform page".
 * Kustom shows this link in its checkout (Namez go-live Phase 3.3).
 */
export async function resolveStoreTermsPath(
  prisma: Pick<PrismaService, 'page' | 'staticPage'>,
  storeId: string,
): Promise<string | null> {
  const page = await prisma.page.findFirst({
    where: {
      store_id: storeId,
      type: 'STATIC',
      static_kind: 'TERMS',
      published_version_id: { not: null },
    },
    select: { slug: true },
  });
  if (page?.slug) return `/${page.slug}`;
  const legacy = await prisma.staticPage.findFirst({
    where: { store_id: storeId, type: 'TERMS', status: 'PUBLISHED' },
    select: { slug: true },
  });
  return legacy?.slug ? `/${legacy.slug}` : null;
}
