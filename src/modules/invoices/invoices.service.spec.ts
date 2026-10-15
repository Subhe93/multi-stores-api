import { UserRole } from '@prisma/client';
import { InvoicesService, canonicalJson } from './invoices.service';
import { InvoiceNumberingService } from './invoice-numbering.service';
import { LegalProfileService } from './legal-profile.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { InvoicePdfService } from './pdf/invoice-pdf.service';
import { PdfUnavailableError } from './pdf/pdf-renderer';
import {
  makeFakePrisma,
  paidOrder,
  STORE_ID,
} from './fake-invoices-prisma.mockspec';

// InvoicesService over the in-memory Prisma fake: idempotent issuing,
// profile completeness, eligibility, credit caps, ownership and the
// app-off rules (writes refused, reads allowed — L1).

function build(
  opts: Parameters<typeof makeFakePrisma>[0] & { enabled?: boolean } = {},
) {
  const fake = makeFakePrisma(opts);
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled ?? true)),
  } as unknown as StoreAppsService;
  const numbering = new InvoiceNumberingService(fake.prisma);
  const profiles = new LegalProfileService(fake.prisma, numbering);
  const pdf = {
    getPdf: jest.fn(() =>
      Promise.resolve({ buffer: Buffer.from('%PDF-'), filename: 'x.pdf' }),
    ),
  };
  const service = new InvoicesService(
    fake.prisma,
    storeApps,
    profiles,
    numbering,
    pdf as unknown as InvoicePdfService,
  );
  return { service, pdf, ...fake };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { getResponse?: () => { code?: string } }).getResponse?.()
      ?.code;
  }
}

const MANUAL = { trigger: 'MANUAL' as const };

describe('InvoicesService.issueForOrder', () => {
  it('issues once; a second call returns the same invoice without consuming a number', async () => {
    const { service, seqs, invoices, mock } = build();
    const first = await service.issueForOrder('o1', MANUAL);
    expect(first.created).toBe(true);
    expect(first.invoice).toMatchObject({
      number: '1001',
      sequence_number: 1001,
      kind: 'INVOICE',
      idempotency_key: 'invoice:o1',
      paid: true,
      gross_total: 125,
      vat_total: 25,
      net_total: 100,
      buyer_name: 'Anna Svensson',
    });
    const snap = first.invoice.snapshot as unknown as {
      refs: { invoice_number: string };
    };
    expect(snap.refs.invoice_number).toBe('1001');
    expect(first.invoice.snapshot_sha256).toHaveLength(64);
    expect(mock.orderTimeline.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'INVOICE_ISSUED',
        note: 'Invoice 1001 issued',
      }) as unknown,
    });

    const again = await service.issueForOrder('o1', MANUAL);
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(first.invoice.id);
    expect(invoices).toHaveLength(1);
    expect(seqs.INVOICE.next_number).toBe(1002);
    expect(seqs.INVOICE.issued_count).toBe(1);
  });

  it('numbers are contiguous across orders', async () => {
    const { service } = build({
      orders: [paidOrder('a'), paidOrder('b'), paidOrder('c')],
    });
    const nums: string[] = [];
    for (const id of ['a', 'b', 'c']) {
      nums.push((await service.issueForOrder(id, MANUAL)).invoice.number);
    }
    expect(nums).toEqual(['1001', '1002', '1003']);
  });

  it('a failure after allocation rolls the counter back (no gap)', async () => {
    const { service, seqs, mock } = build({
      orders: [paidOrder('a'), paidOrder('b')],
    });
    mock.invoice.create.mockImplementationOnce(() =>
      Promise.reject(new Error('boom')),
    );
    await expect(service.issueForOrder('a', MANUAL)).rejects.toThrow('boom');
    expect(seqs.INVOICE.next_number).toBe(1001);
    const b = await service.issueForOrder('b', MANUAL);
    expect(b.invoice.number).toBe('1001');
  });

  it('incomplete profile → INVOICE_PROFILE_INCOMPLETE with missing[]', async () => {
    const { service } = build({ profile: null });
    try {
      await service.issueForOrder('o1', MANUAL);
      throw new Error('expected failure');
    } catch (e) {
      const res = (
        e as { getResponse(): Record<string, unknown> }
      ).getResponse();
      expect(res.code).toBe('INVOICE_PROFILE_INCOMPLETE');
      expect(res.missing).toEqual(
        expect.arrayContaining(['org_number', 'vat_number', 'iban|bankgiro']),
      );
    }
  });

  it('refuses cancelled / failed orders and disabled apps', async () => {
    const cancelled = build({
      orders: [paidOrder('o1', { status: 'CANCELLED' })],
    });
    expect(await codeOf(cancelled.service.issueForOrder('o1', MANUAL))).toBe(
      'INVOICE_ORDER_NOT_ELIGIBLE',
    );
    const failed = build({
      orders: [paidOrder('o1', { payment_status: 'failed' })],
    });
    expect(await codeOf(failed.service.issueForOrder('o1', MANUAL))).toBe(
      'INVOICE_ORDER_NOT_ELIGIBLE',
    );
    const off = build({ enabled: false });
    expect(await codeOf(off.service.issueForOrder('o1', MANUAL))).toBe(
      'STORE_APP_NOT_ENABLED',
    );
    expect(off.invoices).toHaveLength(0);
  });

  it('unpaid manual issue gets a due date and bank details', async () => {
    const { service } = build({
      orders: [paidOrder('o1', { payment_status: 'awaiting_payment' })],
    });
    const { invoice } = await service.issueForOrder('o1', MANUAL);
    expect(invoice.paid).toBe(false);
    const snap = invoice.snapshot as unknown as {
      bank: { bankgiro: string; reference: string };
      refs: { due_date: string; issue_date: string };
    };
    expect(snap.bank).toMatchObject({
      bankgiro: '5050-1055',
      reference: '1001',
    });
    expect(snap.refs.due_date > snap.refs.issue_date).toBe(true);
  });

  it('manual endpoint answers 409 INVOICE_ALREADY_ISSUED with invoice_id', async () => {
    const { service } = build();
    const summary = await service.issueManually(STORE_ID, 'o1', 'creator-user');
    expect(summary).toMatchObject({
      kind: 'INVOICE',
      number: '1001',
      issue_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
      remaining_creditable: 125,
      credited_invoice: null,
      // b2b app M2.5 keys: null on a taxed invoice.
      tax_exempt_reason: null,
      buyer_vat_number: null,
      buyer_country: null,
    });
    try {
      await service.issueManually(STORE_ID, 'o1', 'creator-user');
      throw new Error('expected failure');
    } catch (e) {
      expect(
        (e as { getResponse(): Record<string, unknown> }).getResponse(),
      ).toMatchObject({
        code: 'INVOICE_ALREADY_ISSUED',
        invoice_id: summary.id,
      });
    }
    expect(await codeOf(service.issueManually('s2', 'o1', 'x'))).toBe(
      'ORDER_NOT_FOUND',
    );
  });
});

describe('InvoicesService.issueCreditNote', () => {
  async function issued() {
    const ctx = build();
    const { invoice } = await ctx.service.issueForOrder('o1', MANUAL);
    return { ...ctx, invoiceId: invoice.id };
  }

  it('is idempotent per key and capped at the remainder', async () => {
    const { service, invoiceId, invoices, seqs } = await issued();
    const opts = {
      amount: 30,
      trigger: 'MANUAL' as const,
      idempotencyKey: 'k1',
    };
    const a = await service.issueCreditNote(invoiceId, opts);
    expect(a.created).toBe(true);
    expect(a.invoice).toMatchObject({
      kind: 'CREDIT_NOTE',
      number: 'CN-1',
      gross_total: -30,
      vat_total: -6,
      net_total: -24,
      credited_invoice_id: invoiceId,
    });
    const b = await service.issueCreditNote(invoiceId, opts);
    expect(b.created).toBe(false);
    expect(b.invoice.id).toBe(a.invoice.id);
    expect(seqs.CREDIT_NOTE.next_number).toBe(2);

    expect(
      await codeOf(
        service.issueCreditNote(invoiceId, {
          ...opts,
          amount: 95.01,
          idempotencyKey: 'k2',
        }),
      ),
    ).toBe('INVOICE_CREDIT_EXCEEDS');
    const rest = await service.issueCreditNote(invoiceId, {
      amount: 'full',
      trigger: 'MANUAL',
      idempotencyKey: 'k3',
    });
    expect(rest.invoice.gross_total).toBe(-95);
    expect(
      await codeOf(
        service.issueCreditNote(invoiceId, { ...opts, idempotencyKey: 'k4' }),
      ),
    ).toBe('INVOICE_CREDIT_NOTHING_LEFT');
    expect(invoices.filter((i) => i.kind === 'CREDIT_NOTE')).toHaveLength(2);
    const summary = service.toSummary(
      await (
        service as unknown as {
          prisma: { invoice: { findUnique: (a: unknown) => Promise<never> } };
        }
      ).prisma.invoice.findUnique({ where: { id: invoiceId } }),
    );
    expect(summary.remaining_creditable).toBe(0);
  });

  it('refundCumulative credits only the delta beyond earlier refund credits', async () => {
    const { service, invoiceId } = await issued();
    const r30 = await service.issueCreditNote(invoiceId, {
      amount: { refundCumulative: 30 },
      trigger: 'REFUND',
      idempotencyKey: 'refund:o1:3000',
    });
    const r50 = await service.issueCreditNote(invoiceId, {
      amount: { refundCumulative: 50 },
      trigger: 'REFUND',
      idempotencyKey: 'refund:o1:5000',
    });
    expect([r30.invoice.gross_total, r50.invoice.gross_total]).toEqual([
      -30, -20,
    ]);
    expect(
      await codeOf(
        service.issueCreditNote(invoiceId, {
          amount: { refundCumulative: 40 },
          trigger: 'REFUND',
          idempotencyKey: 'refund:o1:4000',
        }),
      ),
    ).toBe('INVOICE_CREDIT_NOTHING_LEFT');
  });

  it('refuses a foreign store and a disabled app', async () => {
    const { service, invoiceId } = await issued();
    expect(
      await codeOf(
        service.issueCreditNote(invoiceId, {
          amount: 'full',
          trigger: 'MANUAL',
          idempotencyKey: 'x',
          storeId: 's2',
        }),
      ),
    ).toBe('INVOICE_NOT_FOUND');
    (
      service as unknown as { storeApps: { isEnabled: jest.Mock } }
    ).storeApps.isEnabled.mockResolvedValue(false);
    expect(
      await codeOf(
        service.issueCreditNote(invoiceId, {
          amount: 'full',
          trigger: 'MANUAL',
          idempotencyKey: 'y',
        }),
      ),
    ).toBe('STORE_APP_NOT_ENABLED');
  });
});

describe('InvoicesService reads (ownership, L1)', () => {
  async function withInvoice(enabled = true) {
    const ctx = build();
    const { invoice } = await ctx.service.issueForOrder('o1', MANUAL);
    (
      ctx.service as unknown as { storeApps: { isEnabled: jest.Mock } }
    ).storeApps.isEnabled.mockResolvedValue(enabled);
    return { ...ctx, invoiceId: invoice.id };
  }

  it('customer of the order, the store creator and admin read; others get 404', async () => {
    const { service } = await withInvoice();
    const read = (id: string, role: UserRole) =>
      service.findForOrder('o1', { id, role });
    await expect(read('cust-user', UserRole.CUSTOMER)).resolves.toHaveLength(1);
    await expect(read('creator-user', UserRole.CREATOR)).resolves.toHaveLength(
      1,
    );
    await expect(read('admin', UserRole.ADMIN)).resolves.toHaveLength(1);
    expect(await codeOf(read('someone-else', UserRole.CUSTOMER))).toBe(
      'INVOICE_NOT_FOUND',
    );
    expect(await codeOf(read('other-creator', UserRole.CREATOR))).toBe(
      'INVOICE_NOT_FOUND',
    );
  });

  it('reads keep working after the app is disabled (L1)', async () => {
    const { service, invoiceId, pdf } = await withInvoice(false);
    await expect(
      service.findForOrder('o1', { id: 'cust-user', role: UserRole.CUSTOMER }),
    ).resolves.toHaveLength(1);
    await expect(
      service.pdfForUser(invoiceId, {
        id: 'cust-user',
        role: UserRole.CUSTOMER,
      }),
    ).resolves.toMatchObject({ filename: 'x.pdf' });
    expect(pdf.getPdf).toHaveBeenCalledWith(invoiceId);
    await expect(service.detail(STORE_ID, invoiceId)).resolves.toMatchObject({
      number: '1001',
      snapshot: expect.objectContaining({ kind: 'INVOICE' }) as unknown,
    });
    expect(await codeOf(service.detail('s2', invoiceId))).toBe(
      'INVOICE_NOT_FOUND',
    );
  });

  it('PDF engine unavailable → 503 INVOICE_PDF_UNAVAILABLE', async () => {
    const { service, invoiceId, pdf } = await withInvoice();
    pdf.getPdf.mockRejectedValueOnce(new PdfUnavailableError());
    expect(
      await codeOf(
        service.pdfForUser(invoiceId, { id: 'admin', role: UserRole.ADMIN }),
      ),
    ).toBe('INVOICE_PDF_UNAVAILABLE');
    expect(
      await codeOf(
        service.pdfForUser(invoiceId, { id: 'x', role: UserRole.CUSTOMER }),
      ),
    ).toBe('INVOICE_NOT_FOUND');
  });
});

describe('canonicalJson', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe(
      canonicalJson({ a: [{ c: null, d: 2 }], b: 1 }),
    );
  });
});

describe('InvoicesService review fixes (M1, M2)', () => {
  async function issued() {
    const ctx = build();
    const { invoice } = await ctx.service.issueForOrder('o1', MANUAL);
    return { ...ctx, invoiceId: invoice.id };
  }
  const refund = (cumulative: number) => ({
    amount: { refundCumulative: cumulative },
    trigger: 'REFUND' as const,
    idempotencyKey: `refund:o1:${cumulative * 100}`,
  });

  it('M1: a manual credit of 100 then a refund of 100 → no second credit', async () => {
    const { service, invoiceId, invoices } = await issued();
    await service.issueCreditNote(invoiceId, {
      amount: 100,
      trigger: 'MANUAL',
      idempotencyKey: 'm1',
    });
    expect(await codeOf(service.issueCreditNote(invoiceId, refund(100)))).toBe(
      'INVOICE_CREDIT_NOTHING_LEFT',
    );
    expect(invoices.filter((i) => i.kind === 'CREDIT_NOTE')).toHaveLength(1);
  });

  it('M1: a manual credit of 40 then a refund of 100 → credit 60', async () => {
    const { service, invoiceId } = await issued();
    await service.issueCreditNote(invoiceId, {
      amount: 40,
      trigger: 'MANUAL',
      idempotencyKey: 'm1',
    });
    const r = await service.issueCreditNote(invoiceId, refund(100));
    expect(r.invoice.gross_total).toBe(-60);
  });

  it('M2: inconsistent totals refuse to issue, no number consumed', async () => {
    const { service, seqs, invoices } = build({
      orders: [
        paidOrder('o1', {
          // tax_lines claim 20.00 VAT, the order says 25.00.
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
    try {
      await service.issueForOrder('o1', MANUAL);
      throw new Error('expected failure');
    } catch (e) {
      const err = e as {
        getStatus(): number;
        getResponse(): Record<string, unknown>;
      };
      expect(err.getStatus()).toBe(422);
      expect(err.getResponse()).toMatchObject({
        code: 'INVOICE_SNAPSHOT_INVALID',
        problems: [expect.stringContaining('vat_summary') as string],
      });
    }
    expect(seqs.INVOICE.next_number).toBe(1001);
    expect(invoices).toHaveLength(0);
  });

  it('M2: stacked tax rates are refused with a clear message', async () => {
    const { service, seqs } = build({
      orders: [
        paidOrder('o1', {
          tax_amount: 31.25,
          total: 131.25,
          tax_lines: [
            {
              label: 'VAT',
              rate_bp: 2500,
              taxable_amount: 100,
              tax_amount: 25,
            },
            {
              label: 'Extra',
              rate_bp: 500,
              taxable_amount: 125,
              tax_amount: 6.25,
            },
          ],
          items: [
            {
              quantity: 1,
              unit_price: 100,
              total_price: 100,
              tax_rate_bp: 3125,
              product: null,
              variant: null,
              custom_product: null,
              custom_field_values: [],
            },
          ],
        }),
      ],
    });
    try {
      await service.issueForOrder('o1', MANUAL);
      throw new Error('expected failure');
    } catch (e) {
      expect(
        (e as { getResponse(): Record<string, unknown> }).getResponse(),
      ).toMatchObject({
        code: 'INVOICE_SNAPSHOT_INVALID',
        message: 'Stacked tax rates are not supported on invoices yet.',
      });
    }
    expect(seqs.INVOICE.next_number).toBe(1001);
  });

  it('M2: an inconsistent credit note is refused inside the transaction (number rolled back)', async () => {
    const { service, invoiceId, invoices, seqs } = await issued();
    // Corrupt the stored snapshot (in memory; the DB trigger forbids this).
    const snap = invoices[0].snapshot as { lines: { line_net: number }[] };
    snap.lines[0].line_net += 1;
    expect(
      await codeOf(
        service.issueCreditNote(invoiceId, {
          amount: 'full',
          trigger: 'MANUAL',
          idempotencyKey: 'bad',
        }),
      ),
    ).toBe('INVOICE_SNAPSHOT_INVALID');
    expect(seqs.CREDIT_NOTE.next_number).toBe(1);
    expect(invoices.filter((i) => i.kind === 'CREDIT_NOTE')).toHaveLength(0);
  });
});
