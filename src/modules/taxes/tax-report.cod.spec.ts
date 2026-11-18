import { OrderStatus, PaymentMethod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxManagementService } from './tax-management.service';
import { TaxService } from './tax.service';

// A cash-on-delivery order of an independent store is marked paid when it
// is delivered (markCodCollected) and no refund ever moves its payment
// status. Once it is cancelled, refunded or returned it must leave the tax
// report; card and Kustom orders keep the filter they always had.

type Row = {
  id: string;
  payment_method: PaymentMethod;
  status: OrderStatus;
};

type ReportWhere = {
  payment_status: string;
  is_test: boolean;
  deleted_at: null;
  NOT: { payment_method: PaymentMethod; status: { in: OrderStatus[] } };
  store_id?: string;
};

function build(rows: Row[]) {
  const findMany = jest.fn(({ where }: { where: ReportWhere }) =>
    Promise.resolve(
      rows
        .filter(
          (r) =>
            !(
              r.payment_method === where.NOT.payment_method &&
              where.NOT.status.in.includes(r.status)
            ),
        )
        .map((r) => ({
          id: r.id,
          currency: 'SEK',
          tax_basis_country: 'SE',
          tax_lines: [
            { label: 'VAT', rate_bp: 2500, taxable_amount: 80, tax_amount: 20 },
          ],
          address: { country_code: 'SE' },
        })),
    ),
  );
  const service = new TaxManagementService(
    { order: { findMany } } as unknown as PrismaService,
    {} as TaxService,
  );
  return { service, findMany };
}

describe('tax report and cash on delivery', () => {
  it('keeps the paid filter and excludes only closed COD orders', async () => {
    const b = build([]);
    await b.service.report({ from: '2026-11-01', to: '2026-11-30' }, {});
    const where = b.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      payment_status: 'paid',
      is_test: false,
      deleted_at: null,
      NOT: {
        payment_method: PaymentMethod.COD,
        status: {
          in: [
            OrderStatus.CANCELLED,
            OrderStatus.REFUNDED,
            OrderStatus.RETURNED,
          ],
        },
      },
    });
  });

  it('a delivered COD order counts; a returned, refunded or cancelled one does not; card orders are unchanged', async () => {
    const b = build([
      { id: 'cod-delivered', payment_method: 'COD', status: 'DELIVERED' },
      { id: 'cod-returned', payment_method: 'COD', status: 'RETURNED' },
      { id: 'cod-refunded', payment_method: 'COD', status: 'REFUNDED' },
      { id: 'cod-cancelled', payment_method: 'COD', status: 'CANCELLED' },
      // A paid card order an admin set to RETURNED without a Stripe refund
      // stays in the report, as before.
      { id: 'card-returned', payment_method: 'STRIPE', status: 'RETURNED' },
      { id: 'kustom-cancelled', payment_method: 'KUSTOM', status: 'CANCELLED' },
    ]);
    const rows = await b.service.report({ from: '2026-11-01' }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ order_count: 3, tax_amount: 60 });
  });
});
