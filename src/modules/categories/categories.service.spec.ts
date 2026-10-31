import { CategoriesService } from './categories.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Category descriptions are rendered on the storefront as HTML: sanitized on
// create() and update().

type Row = Record<string, unknown>;

function setup() {
  const create = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const prisma = {
    category: {
      create,
      update,
      // WP slug rule: uniqueness lookup.
      findFirst: jest.fn(() => Promise.resolve(null)),
      findUnique: jest.fn(() => Promise.resolve(null)),
    },
    categoryTranslation: { deleteMany: jest.fn() },
  };
  return {
    svc: new CategoriesService(prisma as unknown as PrismaService),
    create,
    update,
  };
}

const descriptions = (data: Row) =>
  (data.translations as { create: Row[] }).create.map((t) => t.description);

describe('CategoriesService HTML sanitizing on write', () => {
  it('create() stores a sanitized description', async () => {
    const { svc, create } = setup();
    await svc.create({
      slug: 'c',
      translations: [
        {
          locale: 'en',
          name: 'N',
          description: '<p>d</p><script>x()</script>',
        },
        { locale: 'sv', name: 'N' },
      ],
    } as never);
    expect(descriptions(create.mock.calls[0][0].data)).toEqual([
      '<p>d</p>',
      undefined,
    ]);
  });

  it('update() stores a sanitized description', async () => {
    const { svc, update } = setup();
    await svc.update('c1', {
      translations: [
        {
          locale: 'en',
          name: 'N',
          description: '<img src=x onerror=alert(1)>',
        },
      ],
    } as never);
    expect(descriptions(update.mock.calls[0][0].data)).toEqual([
      '<img src="x" />',
    ]);
  });
});
