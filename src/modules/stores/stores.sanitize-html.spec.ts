import { StoresService } from './stores.service';
import type { PrismaService } from '../../prisma/prisma.service';

// The store description is rendered on the storefront home page as HTML:
// sanitized on create() and update(); an update without it leaves it alone.

type Row = Record<string, unknown>;

function setup() {
  const create = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 's1', slug: 'shop', ...args.data }),
  );
  const update = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 's1', slug: 'shop', ...args.data }),
  );
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: {
      // Slug lookups (create's conflict check) find nothing; creator/id
      // lookups find the store.
      findUnique: jest.fn(({ where }: { where: { slug?: string } }) =>
        Promise.resolve(
          where.slug ? null : { id: 's1', store_type: 'MARKETPLACE' },
        ),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      create,
      update,
    },
  };
  const svc = new StoresService(
    prisma as unknown as PrismaService,
    { revalidateStoreBySlug: jest.fn(() => Promise.resolve()) } as never,
    {} as never,
    { isEnabled: jest.fn(() => Promise.resolve(false)) } as never,
    { ensureDefaultMarket: jest.fn(() => Promise.resolve()) } as never,
    { invalidate: jest.fn() } as never,
    {} as never,
  );
  return { svc, create, update };
}

describe('StoresService HTML sanitizing on write', () => {
  it('update() stores a sanitized description', async () => {
    const { svc, update } = setup();
    await svc.update('u1', {
      description: '<p>Hi</p><script>alert(1)</script>',
    });
    expect(update.mock.calls[0][0].data.description).toBe('<p>Hi</p>');
  });

  it('update() without description does not touch it', async () => {
    const { svc, update } = setup();
    await svc.update('u1', { name: 'New' });
    expect('description' in update.mock.calls[0][0].data).toBe(false);
  });

  it('create() stores a sanitized description', async () => {
    const { svc, create } = setup();
    await svc.create('u1', {
      slug: 'shop',
      name: 'Shop',
      description: '<p>Hi</p><iframe src="https://evil.example"></iframe>',
    });
    expect(create.mock.calls[0][0].data.description).toBe('<p>Hi</p>');
  });
});
