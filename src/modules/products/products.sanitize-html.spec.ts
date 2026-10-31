import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Product description / short_description are rendered on the storefront as
// HTML, so create() and update() must store the sanitized value.

type Row = Record<string, unknown>;

const XSS =
  '<p>ok</p><script>alert(1)</script><img src="x" onerror="alert(2)">';
const CLEAN = '<p>ok</p><img src="x" />';

function setup() {
  const createMany = jest.fn();
  const productCreate = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 'p1', ...args.data }),
  );
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          creator_id: 'c1',
          variant_option_config: null,
        }),
      ),
      create: productCreate,
      update: jest.fn(),
    },
    productTranslation: {
      findMany: jest.fn(() => Promise.resolve([])),
      findFirst: jest.fn(() => Promise.resolve(null)),
      deleteMany: jest.fn(),
      createMany,
    },
    // WP slug rule: store content locale + uniqueness lookups.
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
    customProductTranslation: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.checkOwnership = jest.fn(() => Promise.resolve());
  internals.assertTaxClassAllowed = jest.fn(() => Promise.resolve());
  internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
  internals.syncVariantsAndImages = jest.fn(() => Promise.resolve());
  internals.revalidateForCreator = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  return { svc, productCreate, createMany };
}

describe('ProductsService HTML sanitizing on write', () => {
  it('update() stores sanitized description and short_description', async () => {
    const { svc, createMany } = setup();
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        {
          locale: 'en',
          title: 'T',
          slug: 's',
          description: XSS,
          short_description: '<b onclick="x()">s</b>',
        },
      ],
    });
    const rows = (createMany.mock.calls[0] as unknown as [{ data: Row[] }])[0]
      .data;
    expect(rows[0].description).toBe(CLEAN);
    expect(rows[0].short_description).toBe('<b>s</b>');
  });

  it('create() stores sanitized translations', async () => {
    const { svc, productCreate } = setup();
    await svc.create('u', UserRole.CREATOR, {
      category_id: 'cat',
      product_type: 'PHYSICAL',
      base_price: 10,
      translations: [{ locale: 'en', title: 'T', slug: 's', description: XSS }],
    } as never);
    const data = productCreate.mock.calls[0][0].data as {
      translations: { create: Row[] };
    };
    expect(data.translations.create[0].description).toBe(CLEAN);
  });
});
