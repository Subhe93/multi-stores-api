import { BadRequestException } from '@nestjs/common';
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

// A rename (creator PUT /stores/my/store and the admin variant) may not move
// a store onto a platform-reserved address; create already refused those.

function build(currentSlug = 'namez') {
  const current = {
    id: 's1',
    slug: currentSlug,
    store_type: 'INDEPENDENT',
    custom_domain: null,
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findUnique: jest.fn(() => Promise.resolve(current)),
      update: jest.fn(),
    },
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    {} as RevalidationService,
    {} as OrdersService,
    {} as StoreAppsService,
    {} as MarketsService,
    {} as MarketsContextService,
    {} as RedirectsService,
    {} as CorsOriginService,
  );
  return { service, prisma };
}

describe('StoresService rename to a reserved slug', () => {
  it.each(['admin', 'api', 'login'])(
    'creator update to "%s" is refused before any write',
    async (slug) => {
      const { service, prisma } = build();
      await expect(
        service.update('u1', { slug } as UpdateStoreDto),
      ).rejects.toMatchObject({
        response: { code: 'STORE_SLUG_RESERVED' },
      });
      expect(prisma.store.update).not.toHaveBeenCalled();
    },
  );

  it('admin update to a reserved slug is refused', async () => {
    const { service, prisma } = build();
    await expect(
      service.adminUpdateByCreatorId('c1', { slug: 'admin' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('a store that already has a reserved slug may keep it', async () => {
    const { service } = build('support');
    // Passes the reserved check; whatever fails later is not STORE_SLUG_RESERVED.
    await service
      .update('u1', { slug: 'support' } as UpdateStoreDto)
      .catch((err: { response?: { code?: string } }) => {
        expect(err.response?.code).not.toBe('STORE_SLUG_RESERVED');
      });
  });
});
