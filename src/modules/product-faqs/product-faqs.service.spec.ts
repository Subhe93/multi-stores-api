import { ProductFaqsService } from './product-faqs.service';
import type { PrismaService } from '../../prisma/prisma.service';

// FAQ answers are rendered on the storefront as HTML: sanitized on write.

type Row = Record<string, unknown>;

function setup() {
  const create = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const prisma = {
    productFaq: {
      create,
      update,
      findUnique: jest.fn(() => Promise.resolve({ id: 'f1' })),
    },
    productFaqTranslation: { deleteMany: jest.fn() },
  };
  return {
    svc: new ProductFaqsService(prisma as unknown as PrismaService),
    create,
    update,
  };
}

const answers = (data: Row) =>
  (data.translations as { create: Row[] }).create.map((t) => t.answer);

describe('ProductFaqsService HTML sanitizing on write', () => {
  it('create() stores a sanitized answer', async () => {
    const { svc, create } = setup();
    await svc.create('p1', {
      translations: [
        {
          locale: 'en',
          question: 'Q?',
          answer: '<p>A</p><script>x()</script>',
        },
      ],
    });
    expect(answers(create.mock.calls[0][0].data)).toEqual(['<p>A</p>']);
  });

  it('update() stores a sanitized answer', async () => {
    const { svc, update } = setup();
    await svc.update('f1', {
      translations: [
        {
          locale: 'en',
          question: 'Q?',
          answer: '<a href="javascript:x()">A</a>',
        },
      ],
    });
    expect(answers(update.mock.calls[0][0].data)).toEqual(['<a>A</a>']);
  });
});
