import { UserRole } from '@prisma/client';
import { PagesService } from './pages.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Legacy static page content is rendered on the storefront as HTML:
// sanitized on create() and update().

type Row = Record<string, unknown>;

function setup() {
  const create = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const prisma = {
    staticPage: {
      create,
      update,
      findUnique: jest.fn(() => Promise.resolve({ id: 'pg1', store_id: 's1' })),
    },
    staticPageTranslation: { deleteMany: jest.fn() },
  };
  return {
    svc: new PagesService(prisma as unknown as PrismaService),
    create,
    update,
  };
}

const contents = (data: Row) =>
  (data.translations as { create: Row[] }).create.map((t) => t.content);

describe('PagesService HTML sanitizing on write', () => {
  it('create() stores sanitized content', async () => {
    const { svc, create } = setup();
    await svc.create(
      's1',
      {
        type: 'CUSTOM',
        slug: 'faq',
        translations: [
          { locale: 'en', title: 'T', content: '<p>c</p><script>x()</script>' },
          { locale: 'sv', title: 'T' },
        ],
      },
      'admin',
      UserRole.ADMIN,
    );
    expect(contents(create.mock.calls[0][0].data)).toEqual([
      '<p>c</p>',
      undefined,
    ]);
  });

  it('update() stores sanitized content', async () => {
    const { svc, update } = setup();
    await svc.update(
      'pg1',
      {
        translations: [
          {
            locale: 'en',
            title: 'T',
            content:
              '<p>c</p><form action="https://evil.example"><input></form>',
          },
        ],
      },
      'admin',
      UserRole.ADMIN,
    );
    expect(contents(update.mock.calls[0][0].data)).toEqual(['<p>c</p>']);
  });
});
