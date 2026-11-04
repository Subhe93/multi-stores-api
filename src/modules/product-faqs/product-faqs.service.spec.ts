import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ProductFaqsService } from './product-faqs.service';
import type { PrismaService } from '../../prisma/prisma.service';

// FAQ answers are rendered on the storefront as HTML: sanitized on write.
// Writes are limited to the product's owner (or an admin).

type Row = Record<string, unknown>;

const CREATOR = { id: 'u-creator', role: UserRole.CREATOR };
const OTHER_CREATOR = { id: 'u-other', role: UserRole.CREATOR };
const PROVIDER = { id: 'u-provider', role: UserRole.PROVIDER };
const ADMIN = { id: 'u-admin', role: UserRole.ADMIN };

function setup(
  product: Row | null = { provider_id: null, creator_id: 'c1' },
  faq: Row | null = { id: 'f1', product_id: 'p1' },
) {
  const create = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const updateMany = jest.fn(() => Promise.resolve({ count: 1 }));
  const del = jest.fn(() => Promise.resolve({}));
  const prisma = {
    productFaq: {
      create,
      update,
      updateMany,
      delete: del,
      findUnique: jest.fn(() => Promise.resolve(faq)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    productFaqTranslation: { deleteMany: jest.fn() },
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
    creator: {
      findUnique: jest.fn((args: { where: { user_id: string } }) =>
        Promise.resolve(
          args.where.user_id === 'u-creator'
            ? { id: 'c1' }
            : args.where.user_id === 'u-other'
              ? { id: 'c2' }
              : null,
        ),
      ),
    },
    provider: {
      findUnique: jest.fn((args: { where: { user_id: string } }) =>
        Promise.resolve(
          args.where.user_id === 'u-provider' ? { id: 'pr1' } : null,
        ),
      ),
    },
  };
  return {
    svc: new ProductFaqsService(prisma as unknown as PrismaService),
    create,
    update,
    updateMany,
    del,
  };
}

const answers = (data: Row) =>
  (data.translations as { create: Row[] }).create.map((t) => t.answer);

const translations = (answer: string) => ({
  translations: [{ locale: 'en', question: 'Q?', answer }],
});

describe('ProductFaqsService HTML sanitizing on write', () => {
  it('create() stores a sanitized answer', async () => {
    const { svc, create } = setup();
    await svc.create(
      'p1',
      translations('<p>A</p><script>x()</script>'),
      CREATOR,
    );
    expect(answers(create.mock.calls[0][0].data)).toEqual(['<p>A</p>']);
  });

  it('update() stores a sanitized answer', async () => {
    const { svc, update } = setup();
    await svc.update(
      'f1',
      translations('<a href="javascript:x()">A</a>'),
      CREATOR,
    );
    expect(answers(update.mock.calls[0][0].data)).toEqual(['<a>A</a>']);
  });
});

describe('ProductFaqsService ownership', () => {
  it('rejects a creator writing FAQs on another store product', async () => {
    const { svc, create, update, del, updateMany } = setup();
    await expect(
      svc.create('p1', translations('x'), OTHER_CREATOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.update('f1', translations('x'), OTHER_CREATOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.delete('f1', OTHER_CREATOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.reorder('p1', ['f1'], OTHER_CREATOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a provider on a creator product, allows its own product', async () => {
    await expect(
      setup().svc.create('p1', translations('x'), PROVIDER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const own = setup({ provider_id: 'pr1', creator_id: null });
    await own.svc.create('p1', translations('x'), PROVIDER);
    expect(own.create).toHaveBeenCalled();
  });

  it('lets the owner and an admin write', async () => {
    const a = setup();
    await a.svc.delete('f1', CREATOR);
    expect(a.del).toHaveBeenCalled();
    const b = setup();
    await b.svc.delete('f1', ADMIN);
    expect(b.del).toHaveBeenCalled();
  });

  it('reorder only touches FAQs of the given product', async () => {
    const { svc, updateMany } = setup();
    await svc.reorder('p1', ['f1', 'f9'], CREATOR);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'f9', product_id: 'p1' },
      data: { sort_order: 1 },
    });
  });

  it('answers 404 for a missing product or FAQ', async () => {
    await expect(
      setup(null).svc.create('p1', translations('x'), ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup(undefined, null).svc.delete('f1', ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
