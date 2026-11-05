import { UserRole } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// GET /custom-products/:id carries the selling store's content languages, so a
// reviewing provider (no access to the creator's store) can pick the locale.

function build(languageConfig: object | null) {
  const prisma = {
    customProduct: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'cp1',
          creator_id: 'c1',
          product: { provider_id: 'p1' },
        }),
      ),
    },
    provider: { findUnique: jest.fn(() => Promise.resolve({ id: 'p1' })) },
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    storeLanguageConfig: {
      findFirst: jest.fn(() => Promise.resolve(languageConfig)),
    },
  };
  const service = new CustomProductsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
  );
  return { service, prisma };
}

describe('CustomProductsService.findById store_language', () => {
  it("returns the creator store's primary and secondary locales to the provider", async () => {
    const { service, prisma } = build({
      primary_locale: 'sv',
      secondary_locales: ['en', 'de'],
    });
    const res = await service.findById('cp1', 'u-prov', UserRole.PROVIDER);
    expect(res.store_language).toEqual({
      primary_locale: 'sv',
      secondary_locales: ['en', 'de'],
    });
    expect(prisma.storeLanguageConfig.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { store: { creator_id: 'c1' } } }),
    );
  });

  it("falls back to 'en' when the store has no language config", async () => {
    const { service } = build(null);
    const res = await service.findById('cp1', 'u-creator', UserRole.CREATOR);
    expect(res.store_language).toEqual({
      primary_locale: 'en',
      secondary_locales: [],
    });
  });

  it("a provider who does not supply the base product gets 404, no locale lookup", async () => {
    const { service, prisma } = build(null);
    prisma.provider.findUnique.mockResolvedValueOnce({ id: 'other' });
    await expect(
      service.findById('cp1', 'u-prov', UserRole.PROVIDER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.storeLanguageConfig.findFirst).not.toHaveBeenCalled();
  });
});
