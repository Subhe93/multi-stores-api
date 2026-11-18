import { StoresService } from './stores.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { CorsOriginService } from '../../common/cors/cors-origin.service';
import type { UpdateStoreDto } from './dto/store.dto';

// The storefront caches a store under `store:<slug>`: after a rename the
// entries of the OLD slug must be dropped as well as those of the new one.

function build() {
  const current = {
    id: 's1',
    slug: 'old-name',
    store_type: 'INDEPENDENT',
    custom_domain: null,
    checkout_settings: null,
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findUnique: jest.fn(() => Promise.resolve(current)),
      update: jest.fn(({ data }: { data: { slug?: string } }) =>
        Promise.resolve({ ...current, ...data }),
      ),
    },
  };
  const revalidation = {
    revalidateStoreBySlug: jest.fn<Promise<void>, [string]>(() =>
      Promise.resolve(),
    ),
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    revalidation as unknown as RevalidationService,
    {} as OrdersService,
    {} as StoreAppsService,
    {} as MarketsService,
    {} as MarketsContextService,
    {} as RedirectsService,
    {} as CorsOriginService,
  );
  const slugs = () =>
    revalidation.revalidateStoreBySlug.mock.calls.map((c) => c[0]);
  return { service, prisma, slugs };
}

describe('StoresService slug rename revalidation', () => {
  it('creator rename revalidates the old and the new slug', async () => {
    const { service, slugs } = build();
    await service.update('u1', { slug: 'new-name' } as UpdateStoreDto);
    expect(slugs()).toEqual(['old-name', 'new-name']);
  });

  it('creator update without a rename revalidates the slug once', async () => {
    const { service, slugs } = build();
    await service.update('u1', { name: 'Shop' } as UpdateStoreDto);
    expect(slugs()).toEqual(['old-name']);
  });

  it('admin rename revalidates the old and the new slug', async () => {
    const { service, slugs } = build();
    await service.adminUpdateByCreatorId('c1', { slug: 'new-name' });
    expect(slugs()).toEqual(['old-name', 'new-name']);
  });
});
