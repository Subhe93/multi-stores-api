import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// Custom-product FAQ answers are rendered as HTML (storefront product page),
// so they are sanitized on write like regular product FAQs.

type Row = Record<string, unknown>;

function setup() {
  const create = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const prisma = {
    customProductFaq: {
      create,
      update,
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'f1', custom_product_id: 'cp1' }),
      ),
    },
    customProductFaqTranslation: { deleteMany: jest.fn() },
  };
  const svc = new CustomProductsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
  );
  // Ownership is covered elsewhere; these tests are about the stored HTML.
  jest
    .spyOn(
      svc as unknown as { assertCreatorOwns: () => Promise<void> },
      'assertCreatorOwns',
    )
    .mockResolvedValue(undefined);
  return { svc, create, update };
}

const answers = (data: Row) =>
  (data.translations as { create: Row[] }).create.map((t) => t.answer);

const evil = [
  {
    locale: 'en',
    question: 'Q?',
    answer: '<p>A</p><img src=x onerror="alert(1)"><script>x()</script>',
  },
];

describe('CustomProductsService FAQ HTML sanitizing', () => {
  it('createFaq() strips script and event handlers', async () => {
    const { svc, create } = setup();
    await svc.createFaq('cp1', 'u1', { translations: evil });
    expect(answers(create.mock.calls[0][0].data)).toEqual([
      '<p>A</p><img src="x" />',
    ]);
  });

  it('updateFaq() strips script and event handlers', async () => {
    const { svc, update } = setup();
    await svc.updateFaq('f1', 'u1', { translations: evil });
    expect(answers(update.mock.calls[0][0].data)).toEqual([
      '<p>A</p><img src="x" />',
    ]);
  });
});
