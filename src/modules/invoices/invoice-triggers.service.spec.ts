import { InvoiceTriggersService } from './invoice-triggers.service';
import { InvoicesService } from './invoices.service';
import { InvoiceNumberingService } from './invoice-numbering.service';
import { LegalProfileService } from './legal-profile.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { InvoicePdfService } from './pdf/invoice-pdf.service';
import {
  makeFakePrisma,
  paidOrder,
  STORE_ID,
} from './fake-invoices-prisma.mockspec';

// Trigger rules (§3.3) over the real InvoicesService and the in-memory
// Prisma fake; the app switch and settings come from a stubbed
// StoreAppsService.

function build(
  opts: {
    enabled?: boolean;
    settings?: Record<string, unknown>;
    orders?: Record<string, unknown>[];
  } = {},
) {
  const fake = makeFakePrisma({ orders: opts.orders });
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled ?? true)),
    getSettings: jest.fn(() => Promise.resolve(opts.settings ?? {})),
  };
  const numbering = new InvoiceNumberingService(fake.prisma);
  const service = new InvoicesService(
    fake.prisma,
    storeApps as unknown as StoreAppsService,
    new LegalProfileService(fake.prisma, numbering),
    numbering,
    {} as InvoicePdfService,
  );
  const triggers = new InvoiceTriggersService(
    storeApps as unknown as StoreAppsService,
    fake.prisma,
    service,
  );
  return { triggers, storeApps, ...fake };
}

const ORDER = { id: 'o1', store_id: STORE_ID, payment_status: 'paid' };
const credits = (invoices: { kind: string; gross_total: number }[]) =>
  invoices.filter((i) => i.kind === 'CREDIT_NOTE').map((i) => i.gross_total);

describe('InvoiceTriggersService', () => {
  it('app off: only isEnabled is consulted, no Prisma call', async () => {
    const { triggers, storeApps, mock } = build({ enabled: false });
    await triggers.onOrderPaid(ORDER);
    await triggers.onStatusChanged(ORDER, 'SHIPPED', 'CANCELLED');
    await triggers.onPartialRefund(ORDER, 30);
    await triggers.onFullRefund(ORDER);
    await triggers.onCancelled(ORDER);
    await triggers.onCodOrderCreated(ORDER);
    expect(storeApps.isEnabled).toHaveBeenCalledTimes(6);
    expect(storeApps.getSettings).not.toHaveBeenCalled();
    for (const model of [mock.order, mock.invoice, mock.storeLegalProfile]) {
      for (const fn of Object.values(model)) expect(fn).not.toHaveBeenCalled();
    }
    expect(mock.$transaction).not.toHaveBeenCalled();
  });

  it('no store_id: returns without even checking the app', async () => {
    const { triggers, storeApps } = build();
    await triggers.onOrderPaid({ ...ORDER, store_id: null });
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
  });

  it('onOrderPaid issues when paid and auto_issue; idempotent on replay', async () => {
    const { triggers, invoices } = build();
    await triggers.onOrderPaid({ ...ORDER, payment_status: 'pending' });
    expect(invoices).toHaveLength(0);
    await triggers.onOrderPaid(ORDER);
    await triggers.onOrderPaid(ORDER);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].trigger).toBe('PAYMENT');

    const manual = build({ settings: { auto_issue: false } });
    await manual.triggers.onOrderPaid(ORDER);
    expect(manual.invoices).toHaveLength(0);
  });

  it('Stripe cumulative partial refunds 30 → 50 credit 30 and 20; replay is a no-op', async () => {
    const { triggers, invoices } = build();
    await triggers.onOrderPaid(ORDER);
    await triggers.onPartialRefund(ORDER, 30);
    await triggers.onPartialRefund(ORDER, 50);
    await triggers.onPartialRefund(ORDER, 50);
    expect(credits(invoices)).toEqual([-30, -20]);
    expect(
      invoices
        .filter((i) => i.kind === 'CREDIT_NOTE')
        .map((i) => i.idempotency_key),
    ).toEqual(['refund:o1:3000', 'refund:o1:5000']);
  });

  it('Kustom increments passed as cumulative give the same result; full refund credits the rest', async () => {
    const { triggers, invoices } = build();
    await triggers.onOrderPaid(ORDER);
    let ledger = 0;
    for (const inc of [30, 20]) {
      ledger += inc;
      await triggers.onPartialRefund(ORDER, ledger);
    }
    await triggers.onFullRefund(ORDER);
    await triggers.onFullRefund(ORDER);
    expect(credits(invoices)).toEqual([-30, -20, -75]);
    // Status flip to REFUNDED after the refund hook: nothing left, no-op.
    await triggers.onStatusChanged(ORDER, 'DELIVERED', 'REFUNDED');
    expect(credits(invoices)).toHaveLength(3);
  });

  it('cancel → full credit (credit_on_cancel); off → nothing', async () => {
    const on = build();
    await on.triggers.onOrderPaid(ORDER);
    await on.triggers.onStatusChanged(ORDER, 'CONFIRMED', 'CANCELLED');
    await on.triggers.onCancelled(ORDER);
    expect(credits(on.invoices)).toEqual([-125]);
    expect(on.invoices[1]).toMatchObject({
      trigger: 'CANCELLATION',
      idempotency_key: 'cancel:o1',
    });

    const off = build({ settings: { credit_on_cancel: false } });
    await off.triggers.onOrderPaid(ORDER);
    await off.triggers.onCancelled(ORDER);
    expect(credits(off.invoices)).toEqual([]);
  });

  it('credit triggers no-op without an invoice', async () => {
    const { triggers, invoices, mock } = build();
    await triggers.onFullRefund(ORDER);
    await triggers.onPartialRefund(ORDER, 10);
    await triggers.onCancelled(ORDER);
    expect(invoices).toHaveLength(0);
    expect(mock.$transaction).not.toHaveBeenCalled();
  });

  it('COD: DELIVERED issues only with cod_issue_on=delivered; created only with created', async () => {
    const cod = paidOrder('o1', {
      payment_method: 'COD',
      payment_status: 'pending',
      status: 'DELIVERED',
    });
    const codOrder = { id: 'o1', store_id: STORE_ID, payment_method: 'COD' };

    const delivered = build({ orders: [cod] });
    await delivered.triggers.onCodOrderCreated(codOrder);
    expect(delivered.invoices).toHaveLength(0);
    await delivered.triggers.onStatusChanged(codOrder, 'SHIPPED', 'DELIVERED');
    expect(delivered.invoices).toHaveLength(1);
    expect(delivered.invoices[0]).toMatchObject({
      trigger: 'COD_DELIVERED',
      paid: true,
    });

    const created = build({
      orders: [cod],
      settings: { cod_issue_on: 'created' },
    });
    await created.triggers.onStatusChanged(codOrder, 'SHIPPED', 'DELIVERED');
    expect(created.invoices).toHaveLength(0);
    await created.triggers.onCodOrderCreated(codOrder);
    expect(created.invoices[0]).toMatchObject({ trigger: 'COD_CREATED' });

    // A card order reaching DELIVERED is not a COD trigger.
    const card = build();
    await card.triggers.onStatusChanged(
      { ...codOrder, payment_method: 'STRIPE' },
      'SHIPPED',
      'DELIVERED',
    );
    expect(card.invoices).toHaveLength(0);
  });

  it('errors are swallowed (logged), never thrown', async () => {
    const { triggers, mock } = build();
    mock.order.findUnique.mockRejectedValue(new Error('db down'));
    await expect(triggers.onOrderPaid(ORDER)).resolves.toBeUndefined();
    const broken = build();
    broken.storeApps.isEnabled.mockRejectedValue(new Error('cache'));
    await expect(broken.triggers.onCancelled(ORDER)).resolves.toBeUndefined();
  });
});

describe('InvoiceTriggersService.onAuthorizationReleased (L4)', () => {
  it('always credits in full, even with credit_on_cancel=false; idempotent', async () => {
    const { triggers, invoices } = build({
      settings: { credit_on_cancel: false },
    });
    await triggers.onOrderPaid(ORDER);
    await triggers.onAuthorizationReleased(ORDER);
    await triggers.onAuthorizationReleased(ORDER);
    expect(credits(invoices)).toEqual([-125]);
    expect(invoices[1]).toMatchObject({
      trigger: 'CANCELLATION',
      idempotency_key: 'cancel:o1',
    });
  });

  it('M2 refusals are swallowed by triggers (logged, nothing issued)', async () => {
    const { triggers, invoices, seqs } = build({
      orders: [
        paidOrder('o1', {
          tax_lines: [
            {
              label: 'Moms',
              rate_bp: 2500,
              taxable_amount: 80,
              tax_amount: 20,
            },
          ],
        }),
      ],
    });
    await expect(triggers.onOrderPaid(ORDER)).resolves.toBeUndefined();
    expect(invoices).toHaveLength(0);
    expect(seqs.INVOICE.next_number).toBe(1001);
  });
});
