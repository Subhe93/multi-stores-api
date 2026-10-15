import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { TaxManagementService } from './tax-management.service';
import { TaxService } from './tax.service';
import {
  aggregateEcSales,
  ecSalesCsv,
  ecSalesPeriodKey,
  zonedDayStart,
} from './ec-sales-report';
import type { EcSalesQueryDto } from './dto/tax.dto';

// EC sales list (b2b app M2.5, D11).

describe('ec-sales helpers', () => {
  it('buckets by month or quarter (UTC)', () => {
    const d = new Date('2026-11-30T23:30:00Z');
    expect(ecSalesPeriodKey(d, 'month')).toBe('2026-11');
    expect(ecSalesPeriodKey(d, 'quarter')).toBe('2026-Q4');
    expect(ecSalesPeriodKey(new Date('2026-01-01T00:00:00Z'), 'quarter')).toBe(
      '2026-Q1',
    );
  });

  it('nets credit notes and converts to the store currency', () => {
    const rows = aggregateEcSales(
      [
        {
          date: new Date('2026-10-02T00:00:00Z'),
          buyer_country: 'DE',
          buyer_vat_number: 'DE123456789',
          buyer_name: 'Muster GmbH',
          amount: 1000,
          currency: 'EUR',
          fx_rate: 0.087,
        },
        {
          date: new Date('2026-11-02T00:00:00Z'),
          buyer_country: 'DE',
          buyer_vat_number: 'DE123456789',
          buyer_name: 'Muster GmbH',
          amount: -200,
          currency: 'EUR',
          fx_rate: 0.087,
        },
        {
          date: new Date('2026-12-02T00:00:00Z'),
          buyer_country: 'FI',
          buyer_vat_number: 'FI12345678',
          buyer_name: null,
          amount: 500,
          currency: 'SEK',
          fx_rate: null,
        },
      ],
      'quarter',
      'SEK',
    );
    expect(rows).toEqual([
      {
        period: '2026-Q4',
        buyer_country: 'DE',
        buyer_vat_number: 'DE123456789',
        buyer_name: 'Muster GmbH',
        goods_amount: 800,
        currency: 'EUR',
        goods_amount_store_currency:
          Math.round(
            Math.round((1000 / 0.087) * 100) - Math.round((200 / 0.087) * 100),
          ) / 100,
        store_currency: 'SEK',
        document_count: 2,
      },
      {
        period: '2026-Q4',
        buyer_country: 'FI',
        buyer_vat_number: 'FI12345678',
        buyer_name: null,
        goods_amount: 500,
        currency: 'SEK',
        goods_amount_store_currency: 500,
        store_currency: 'SEK',
        document_count: 1,
      },
    ]);
  });

  it('CSV: numbers raw (negative not escaped), text guarded', () => {
    const csv = ecSalesCsv([
      {
        period: '2026-10',
        buyer_country: 'DE',
        buyer_vat_number: 'DE123456789',
        buyer_name: '=HYPERLINK("x")',
        goods_amount: -120.5,
        currency: 'EUR',
        goods_amount_store_currency: -1385.06,
        store_currency: 'SEK',
        document_count: 1,
      },
    ]);
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toBe(
      'period,buyer_country,buyer_vat_number,buyer_name,goods_amount,currency,goods_amount_store_currency,store_currency,document_count',
    );
    expect(row).toBe(
      `2026-10,DE,DE123456789,"'=HYPERLINK(""x"")",-120.50,EUR,-1385.06,SEK,1`,
    );
  });
});

describe('TaxManagementService.ecSalesReport', () => {
  function build(invoicesEnabled: boolean) {
    const prisma = {
      storeLegalProfile: {
        findFirst: jest.fn(() =>
          Promise.resolve({ timezone: 'Europe/Stockholm' }),
        ),
      },
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({ store_type: 'INDEPENDENT', currency: 'SEK' }),
        ),
      },
      platformConfig: {
        findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
      },
      invoice: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              issue_date: new Date('2026-10-05T00:00:00Z'),
              net_total: 1392,
              currency: 'EUR',
              buyer_name: 'Muster GmbH',
              buyer_vat_number: 'DE123456789',
              buyer_country: 'DE',
              order: { fx_rate_snapshot: 0.1 },
            },
            {
              issue_date: new Date('2026-11-05T00:00:00Z'),
              net_total: -392,
              currency: 'EUR',
              buyer_name: 'Muster GmbH',
              buyer_vat_number: 'DE123456789',
              buyer_country: 'DE',
              order: { fx_rate_snapshot: 0.1 },
            },
          ]),
        ),
      },
      order: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              created_at: new Date('2026-10-05T00:00:00Z'),
              updated_at: new Date('2026-12-20T00:00:00Z'),
              timeline: [{ created_at: new Date('2026-11-03T10:00:00Z') }],
              payment_status: 'refunded',
              total: 517.6,
              currency: 'SEK',
              company_name: 'Muster GmbH',
              vat_number: null,
              vat_validation: { vat_number: 'DE123456789' },
              fx_rate_snapshot: null,
              address: { country_code: 'de' },
            },
            {
              // 23:30 UTC on Sep 30 is Oct 1 in Stockholm.
              created_at: new Date('2026-09-30T23:30:00Z'),
              updated_at: new Date('2026-09-30T23:30:00Z'),
              timeline: [],
              payment_status: 'paid',
              total: 100,
              currency: 'SEK',
              company_name: 'Muster GmbH',
              vat_number: 'DE123456789',
              vat_validation: null,
              fx_rate_snapshot: null,
              address: { country_code: 'DE' },
            },
          ]),
        ),
      },
    };
    const storeApps = {
      isEnabled: jest.fn(() => Promise.resolve(invoicesEnabled)),
    };
    const service = new TaxManagementService(
      prisma as unknown as PrismaService,
      {} as TaxService,
      storeApps as unknown as StoreAppsService,
    );
    return { service, prisma };
  }
  const query = {
    from: '2026-10-01',
    to: '2026-12-31',
    period: 'quarter',
  } as EcSalesQueryDto;

  it('invoices source: signed documents, store currency via fx_rate_snapshot', async () => {
    const { service, prisma } = build(true);
    const r = await service.ecSalesReport(query, { store_id: 's1' });
    const where = (
      prisma.invoice.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where).toMatchObject({
      store_id: 's1',
      tax_exempt_reason: 'REVERSE_CHARGE',
    });
    expect(r).toEqual({
      source: 'invoices',
      partial_refunds_included: true,
      rows: [
        {
          period: '2026-Q4',
          buyer_country: 'DE',
          buyer_vat_number: 'DE123456789',
          buyer_name: 'Muster GmbH',
          goods_amount: 1000,
          currency: 'EUR',
          goods_amount_store_currency: 10000,
          store_currency: 'SEK',
          document_count: 2,
        },
      ],
    });
  });

  it('orders fallback: refunded orders mirrored, flag set', async () => {
    const { service, prisma } = build(false);
    const r = await service.ecSalesReport(query, { store_id: 's1' });
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(r.source).toBe('orders');
    expect(r.partial_refunds_included).toBe(false);
    expect(r.rows).toEqual([
      expect.objectContaining({
        buyer_vat_number: 'DE123456789',
        buyer_country: 'DE',
        goods_amount: 100,
        document_count: 3,
      }),
    ]);
  });

  it('orders fallback: refund dated by the REFUNDED timeline entry, periods in the seller timezone', async () => {
    const { service } = build(false);
    const r = await service.ecSalesReport(
      { ...query, period: 'month' } as EcSalesQueryDto,
      { store_id: 's1' },
    );
    expect(
      r.rows.map((row) => [row.period, row.goods_amount, row.document_count]),
    ).toEqual([
      // Oct: the sale (517.6) + the Stockholm-Oct-1 order (100).
      ['2026-10', 617.6, 2],
      // Nov: the refund mirror, dated by the timeline (not Dec updated_at).
      ['2026-11', -517.6, 1],
    ]);
  });

  it('TAX_REPORT_RANGE_INVALID for a reversed range', async () => {
    const { service } = build(false);
    await expect(
      service.ecSalesReport(
        { from: '2026-12-01', to: '2026-10-01' } as EcSalesQueryDto,
        { store_id: 's1' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'TAX_REPORT_RANGE_INVALID' },
    });
  });
});

describe('seller timezone helpers', () => {
  it('buckets instants in the given zone, date-only values by UTC parts', () => {
    const late = new Date('2026-09-30T23:30:00Z');
    expect(ecSalesPeriodKey(late, 'month')).toBe('2026-09');
    expect(ecSalesPeriodKey(late, 'month', 'Europe/Stockholm')).toBe('2026-10');
    expect(ecSalesPeriodKey(late, 'quarter', 'Europe/Stockholm')).toBe(
      '2026-Q4',
    );
    expect(
      ecSalesPeriodKey(
        new Date('2026-10-01T00:00:00Z'),
        'month',
        'America/New_York',
        true,
      ),
    ).toBe('2026-10');
  });

  it('local day start across DST', () => {
    expect(zonedDayStart('2026-10-01', 'Europe/Stockholm').toISOString()).toBe(
      '2026-09-30T22:00:00.000Z',
    );
    expect(zonedDayStart('2026-12-01', 'Europe/Stockholm').toISOString()).toBe(
      '2026-11-30T23:00:00.000Z',
    );
    expect(zonedDayStart('2026-10-01', 'Not/AZone').toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});
