import { ProductStatus, UserRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Who reads a product outside the storefront (`GET /products/:id`, the
 * variant reads). The provider catalogue is not public: a provider's cost
 * price (base_price) and stock are visible to the provider itself, to
 * creators deciding what to import (published products only) and to admins.
 */
export type CatalogueViewer = {
  role: UserRole;
  /** The caller's provider id (PROVIDER role with a profile), else null. */
  providerId: string | null;
  /** The caller's creator id (CREATOR role with a profile), else null. */
  creatorId: string | null;
};

/**
 * What a viewer may read of one product:
 * - 'full': the owner's record (admins, the owning provider or creator);
 * - 'catalogue': a published provider product as a creator browsing to
 *   import sees it (redacted: no cost_price, importer refs or owner notes);
 * - null: nothing (callers answer 404, so ids cannot be probed).
 * Customers, competing providers and creators looking at drafts or at
 * another creator's products all get null.
 */
export function catalogueReadLevel(
  p: {
    provider_id: string | null;
    creator_id: string | null;
    status: ProductStatus;
  },
  v: CatalogueViewer,
): 'full' | 'catalogue' | null {
  if (v.role === UserRole.ADMIN) return 'full';
  if (
    v.role === UserRole.PROVIDER &&
    v.providerId !== null &&
    p.provider_id === v.providerId
  ) {
    return 'full';
  }
  if (v.role === UserRole.CREATOR) {
    if (v.creatorId !== null && p.creator_id === v.creatorId) return 'full';
    if (p.provider_id !== null && p.status === ProductStatus.PUBLISHED) {
      return 'catalogue';
    }
  }
  return null;
}

/** The two profile lookups catalogue reads need. */
export type CatalogueViewerLookups = Pick<
  PrismaService,
  'provider' | 'creator'
>;

/**
 * The viewer of a catalogue read: at most one profile lookup by user id
 * (none for admins and for every other role).
 */
export async function loadCatalogueViewer(
  prisma: CatalogueViewerLookups,
  userId: string | null | undefined,
  role: UserRole | null | undefined,
): Promise<CatalogueViewer> {
  const viewer: CatalogueViewer = {
    role: role ?? UserRole.CUSTOMER,
    providerId: null,
    creatorId: null,
  };
  if (!userId) return viewer;
  if (role === UserRole.PROVIDER) {
    const provider = await prisma.provider.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    viewer.providerId = provider?.id ?? null;
  } else if (role === UserRole.CREATOR) {
    const creator = await prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    viewer.creatorId = creator?.id ?? null;
  }
  return viewer;
}
