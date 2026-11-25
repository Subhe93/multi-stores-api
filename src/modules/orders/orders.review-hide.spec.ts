import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { OrderStatus, UserRole } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { personalizationCoreArgs } from '../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import type { SecurityAuditService } from '../security/security-audit.service';
import type { ReviewsService } from '../reviews/reviews.service';

// M171: an order that stops being a real purchase (trashed, flagged test)
// hides its reviews through ReviewsService.hideForOrders. The call is best
// effort: it runs after the order write and can never fail the order action.

const ADMIN = { id: 'admin-1', email: 'admin@test', role: UserRole.ADMIN };
const CREATOR = { id: 'user-c1', email: 'c1@test', role: UserRole.CREATOR };

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  order_number: 'MS-1',
  store_id: 's1',
  status: OrderStatus.PENDING,
  payment_status: 'awaiting_payment',
  paid_at: null,
  stripe_charge_id: null,
  kustom_capture_id: null,
  coupon_released_at: null,
  is_test: false,
  total: 299,
  currency: 'SEK',
  deleted_at: null,
  deleted_by: null,
  _count: { payouts: 0, invoices: 0 },
  ...over,
});

function build(opts: { withReviews?: boolean } = {}) {
  const prisma = {
    order: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(order())),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderTimeline: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    orderItem: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
    },
    product: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    productVariant: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    promotionUsage: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
    },
    promotion: { update: jest.fn(() => Promise.resolve({})) },
    creator: {
      findUnique: jest.fn(
        (): Promise<unknown> =>
          Promise.resolve({ id: 'cr1', store: { id: 's1' } }),
      ),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const reviews = {
    hideForOrders: jest.fn((_ids: readonly string[]) =>
      Promise.resolve({ hidden: 1 }),
    ),
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {
      releaseRedemption: jest.fn(() => Promise.resolve()),
    } as unknown as PromotionsService,
    {} as ShippingService,
    {} as MailService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as MarketPricingService,
    {} as ConfigService,
    {} as B2bService,
    ...personalizationCoreArgs(prisma as never),
    undefined, // invoices
    undefined, // b2bTax
    undefined, // personalization
    undefined, // production
    undefined, // designerCart
    undefined, // designerTriggers
    audit as unknown as SecurityAuditService,
    undefined, // metaConversions
    undefined, // revalidation
    opts.withReviews === false
      ? undefined
      : (reviews as unknown as ReviewsService),
  );
  jest
    .spyOn(service, 'findById')
    .mockImplementation((id: string) => Promise.resolve({ id } as never));
  return { service, prisma, audit, reviews };
}

describe('orders -> reviews hook (M171)', () => {
  describe('trash', () => {
    it('deleteOrder hides the reviews of the order, after the delete committed', async () => {
      const b = build();
      const sequence: string[] = [];
      b.prisma.$transaction.mockImplementation(
        async (fn: (tx: unknown) => unknown) => {
          const out = await fn(b.prisma);
          sequence.push('commit');
          return out;
        },
      );
      b.reviews.hideForOrders.mockImplementation(() => {
        sequence.push('hide');
        return Promise.resolve({ hidden: 1 });
      });
      await b.service.deleteOrder('o1', CREATOR);
      expect(b.reviews.hideForOrders).toHaveBeenCalledTimes(1);
      expect(b.reviews.hideForOrders).toHaveBeenCalledWith(['o1']);
      expect(sequence).toEqual(['commit', 'hide']);
    });

    it('bulk delete: once per trashed order, never for a skipped one', async () => {
      const b = build();
      b.prisma.order.findUnique.mockImplementation(((args: {
        where: { id: string };
      }) =>
        Promise.resolve(
          args.where.id === 'paid'
            ? order({ id: 'paid', payment_status: 'paid', paid_at: new Date() })
            : order({ id: args.where.id }),
        )) as never);
      const res = await b.service.bulkDeleteOrders(['o1', 'paid', 'o2'], ADMIN);
      expect(res.deleted).toEqual(['o1', 'o2']);
      expect(res.skipped.map((s) => s.id)).toEqual(['paid']);
      expect(b.reviews.hideForOrders.mock.calls.map(([ids]) => ids)).toEqual([
        ['o1'],
        ['o2'],
      ]);
    });

    it('an order that cannot be deleted hides nothing', async () => {
      const b = build();
      b.prisma.order.findUnique.mockResolvedValue(
        order({ payment_status: 'paid', paid_at: new Date() }),
      );
      await expect(b.service.deleteOrder('o1', ADMIN)).rejects.toBeDefined();
      expect(b.reviews.hideForOrders).not.toHaveBeenCalled();
    });

    it('a creator cannot reach the hook through an order of another store', async () => {
      const b = build();
      b.prisma.order.findUnique.mockResolvedValue(order({ store_id: 'other' }));
      await expect(b.service.deleteOrder('o1', CREATOR)).rejects.toBeDefined();
      expect(b.reviews.hideForOrders).not.toHaveBeenCalled();
    });

    it('a failure of the hook never fails the delete (logged)', async () => {
      const b = build();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        b.reviews.hideForOrders.mockRejectedValue(new Error('db down'));
        await expect(b.service.deleteOrder('o1', ADMIN)).resolves.toEqual({
          id: 'o1',
        });
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'order.deleted' }),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Hiding the reviews of order o1 failed'),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('restore never re-approves (the hook is not called)', async () => {
      const b = build();
      b.prisma.order.findUnique.mockResolvedValue(
        order({ deleted_at: new Date(), deleted_by: 'admin-1' }),
      );
      await b.service.bulkRestoreOrders(['o1'], ADMIN);
      expect(b.reviews.hideForOrders).not.toHaveBeenCalled();
    });
  });

  describe('test flag', () => {
    it('setTestFlag(true) hides the reviews after the flag is written', async () => {
      const b = build();
      const sequence: string[] = [];
      b.prisma.order.update.mockImplementation(() => {
        sequence.push('flag');
        return Promise.resolve({});
      });
      b.reviews.hideForOrders.mockImplementation(() => {
        sequence.push('hide');
        return Promise.resolve({ hidden: 1 });
      });
      await b.service.setTestFlag('o1', true, ADMIN);
      expect(b.reviews.hideForOrders).toHaveBeenCalledWith(['o1']);
      expect(sequence).toEqual(['flag', 'hide']);
    });

    it('unflagging (false) and a no-op flag never call the hook', async () => {
      const b = build();
      b.prisma.order.findUnique.mockResolvedValue(order({ is_test: true }));
      await b.service.setTestFlag('o1', false, ADMIN);
      await b.service.setTestFlag('o1', true, ADMIN); // already test
      expect(b.reviews.hideForOrders).not.toHaveBeenCalled();
    });

    it('a refused flag (invoiced / trashed order) hides nothing', async () => {
      const b = build();
      b.prisma.order.findUnique.mockResolvedValue(
        order({ _count: { payouts: 0, invoices: 1 } }),
      );
      await expect(
        b.service.setTestFlag('o1', true, ADMIN),
      ).rejects.toBeDefined();
      b.prisma.order.findUnique.mockResolvedValue(
        order({ deleted_at: new Date() }),
      );
      await expect(
        b.service.setTestFlag('o1', true, ADMIN),
      ).rejects.toBeDefined();
      expect(b.reviews.hideForOrders).not.toHaveBeenCalled();
    });

    it('a failure of the hook never fails the flag', async () => {
      const b = build();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        b.reviews.hideForOrders.mockRejectedValue(new Error('db down'));
        await expect(b.service.setTestFlag('o1', true, ADMIN)).resolves.toEqual(
          { id: 'o1' },
        );
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'order.test_flag' }),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('without the reviews service (older positional constructors) nothing changes', async () => {
    const b = build({ withReviews: false });
    await expect(b.service.deleteOrder('o1', ADMIN)).resolves.toEqual({
      id: 'o1',
    });
    await expect(b.service.setTestFlag('o1', true, ADMIN)).resolves.toEqual({
      id: 'o1',
    });
  });
});
