import { ProductStatus, UserRole } from '@prisma/client';
import {
  catalogueReadLevel,
  gatedCatalogueReadLevel,
  loadCatalogueViewer,
  providerInCatalogue,
  type CatalogueViewer,
} from './catalogue-access';
import type { PrismaService } from '../../prisma/prisma.service';

// Supplier privacy: who may read a product (and its variants) outside the
// storefront. The provider's cost price and stock are for the provider, the
// creators importing its published products and admins only.

const ADMIN: CatalogueViewer = {
  role: UserRole.ADMIN,
  providerId: null,
  creatorId: null,
};
const PROV_A: CatalogueViewer = {
  role: UserRole.PROVIDER,
  providerId: 'pA',
  creatorId: null,
};
const PROV_NO_PROFILE: CatalogueViewer = {
  role: UserRole.PROVIDER,
  providerId: null,
  creatorId: null,
};
const CREATOR_1: CatalogueViewer = {
  role: UserRole.CREATOR,
  providerId: null,
  creatorId: 'c1',
};
const CREATOR_NO_PROFILE: CatalogueViewer = {
  role: UserRole.CREATOR,
  providerId: null,
  creatorId: null,
};
const CUSTOMER: CatalogueViewer = {
  role: UserRole.CUSTOMER,
  providerId: null,
  creatorId: null,
};

const providerOf = (provider_id: string, status: ProductStatus) => ({
  provider_id,
  creator_id: null,
  status,
});
const creatorOf = (creator_id: string, status: ProductStatus) => ({
  provider_id: null,
  creator_id,
  status,
});
const { PUBLISHED, DRAFT, ARCHIVED, PENDING_REVIEW } = ProductStatus;

describe('catalogueReadLevel', () => {
  it.each([
    // viewer, product, level
    ['admin / provider draft', ADMIN, providerOf('pA', DRAFT), 'full'],
    ['admin / creator draft', ADMIN, creatorOf('c9', DRAFT), 'full'],
    ['provider / own published', PROV_A, providerOf('pA', PUBLISHED), 'full'],
    ['provider / own draft', PROV_A, providerOf('pA', DRAFT), 'full'],
    [
      'provider / competitor published',
      PROV_A,
      providerOf('pB', PUBLISHED),
      null,
    ],
    ['provider / competitor draft', PROV_A, providerOf('pB', DRAFT), null],
    ['provider / creator product', PROV_A, creatorOf('c1', PUBLISHED), null],
    [
      'provider without profile / provider product',
      PROV_NO_PROFILE,
      providerOf('pA', PUBLISHED),
      null,
    ],
    ['creator / own published', CREATOR_1, creatorOf('c1', PUBLISHED), 'full'],
    ['creator / own draft', CREATOR_1, creatorOf('c1', DRAFT), 'full'],
    [
      'creator / other creator published',
      CREATOR_1,
      creatorOf('c2', PUBLISHED),
      null,
    ],
    [
      'creator / provider published',
      CREATOR_1,
      providerOf('pA', PUBLISHED),
      'catalogue',
    ],
    ['creator / provider draft', CREATOR_1, providerOf('pA', DRAFT), null],
    [
      'creator / provider archived',
      CREATOR_1,
      providerOf('pA', ARCHIVED),
      null,
    ],
    [
      'creator / provider pending review',
      CREATOR_1,
      providerOf('pA', PENDING_REVIEW),
      null,
    ],
    [
      'creator without profile / provider published',
      CREATOR_NO_PROFILE,
      providerOf('pA', PUBLISHED),
      'catalogue',
    ],
    [
      'creator without profile / creator product',
      CREATOR_NO_PROFILE,
      creatorOf('c1', PUBLISHED),
      null,
    ],
    [
      'customer / provider published',
      CUSTOMER,
      providerOf('pA', PUBLISHED),
      null,
    ],
    [
      'customer / creator published',
      CUSTOMER,
      creatorOf('c1', PUBLISHED),
      null,
    ],
  ] as const)('%s', (_label, viewer, product, level) => {
    expect(catalogueReadLevel(product, viewer)).toBe(level);
  });
});

describe('loadCatalogueViewer', () => {
  function lookups() {
    return {
      provider: { findUnique: jest.fn(() => Promise.resolve({ id: 'pA' })) },
      creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    };
  }
  const load = (
    l: ReturnType<typeof lookups>,
    userId: string | undefined,
    role: UserRole | undefined,
  ) => loadCatalogueViewer(l as unknown as PrismaService, userId, role);

  it('one provider lookup for a provider, one creator lookup for a creator', async () => {
    const l = lookups();
    expect(await load(l, 'u1', UserRole.PROVIDER)).toEqual(PROV_A);
    expect(l.provider.findUnique).toHaveBeenCalledWith({
      where: { user_id: 'u1' },
      select: { id: true },
    });
    expect(l.creator.findUnique).not.toHaveBeenCalled();

    const l2 = lookups();
    expect(await load(l2, 'u2', UserRole.CREATOR)).toEqual(CREATOR_1);
    expect(l2.provider.findUnique).not.toHaveBeenCalled();
  });

  it('admins, customers and callers without a user id: no lookup', async () => {
    const l = lookups();
    expect(await load(l, 'u1', UserRole.ADMIN)).toEqual(ADMIN);
    expect(await load(l, 'u1', UserRole.CUSTOMER)).toEqual(CUSTOMER);
    expect((await load(l, undefined, UserRole.PROVIDER)).providerId).toBeNull();
    expect((await load(l, 'u1', undefined)).role).toBe(UserRole.CUSTOMER);
    expect(l.provider.findUnique).not.toHaveBeenCalled();
    expect(l.creator.findUnique).not.toHaveBeenCalled();
  });
});

describe('provider approval gate (providerInCatalogue, gatedCatalogueReadLevel)', () => {
  function gate(require: boolean | null, verified: boolean | null) {
    return {
      platformConfig: {
        findFirst: jest.fn(() =>
          Promise.resolve(
            require === null ? null : { require_provider_approval: require },
          ),
        ),
      },
      provider: {
        findUnique: jest.fn(() =>
          Promise.resolve(verified === null ? null : { verified }),
        ),
      },
    };
  }
  const asPrisma = (g: ReturnType<typeof gate>) =>
    g as unknown as PrismaService;

  it('approval required (or no config row): only a verified provider is in the catalogue', async () => {
    expect(await providerInCatalogue(asPrisma(gate(true, true)), 'pA')).toBe(
      true,
    );
    expect(await providerInCatalogue(asPrisma(gate(true, false)), 'pA')).toBe(
      false,
    );
    expect(await providerInCatalogue(asPrisma(gate(null, false)), 'pA')).toBe(
      false,
    );
    expect(await providerInCatalogue(asPrisma(gate(true, null)), 'pA')).toBe(
      false,
    );
  });

  it('approval not required: every provider, without a provider lookup', async () => {
    const g = gate(false, false);
    expect(await providerInCatalogue(asPrisma(g), 'pA')).toBe(true);
    expect(g.provider.findUnique).not.toHaveBeenCalled();
  });

  it('a creator reading an unverified provider product by id gets nothing', async () => {
    expect(
      await gatedCatalogueReadLevel(
        asPrisma(gate(true, false)),
        providerOf('pB', PUBLISHED),
        CREATOR_1,
      ),
    ).toBeNull();
    expect(
      await gatedCatalogueReadLevel(
        asPrisma(gate(true, true)),
        providerOf('pB', PUBLISHED),
        CREATOR_1,
      ),
    ).toBe('catalogue');
  });

  it('owners and admins are never gated (no lookup)', async () => {
    const g = gate(true, false);
    expect(
      await gatedCatalogueReadLevel(
        asPrisma(g),
        providerOf('pA', DRAFT),
        PROV_A,
      ),
    ).toBe('full');
    expect(
      await gatedCatalogueReadLevel(
        asPrisma(g),
        providerOf('pB', PUBLISHED),
        ADMIN,
      ),
    ).toBe('full');
    expect(
      await gatedCatalogueReadLevel(
        asPrisma(g),
        providerOf('pB', PUBLISHED),
        CUSTOMER,
      ),
    ).toBeNull();
    expect(g.platformConfig.findFirst).not.toHaveBeenCalled();
  });
});
