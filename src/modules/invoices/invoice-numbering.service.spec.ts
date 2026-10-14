import {
  formatInvoiceNumber,
  InvoiceNumberingService,
  isValidPrefix,
} from './invoice-numbering.service';
import { makeFakePrisma, PROFILE_ID } from './fake-invoices-prisma.mockspec';

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { getResponse?: () => { code?: string } }).getResponse?.()
      ?.code;
  }
}

describe('invoice numbering', () => {
  it('formats prefix + padded number', () => {
    expect(formatInvoiceNumber('INV-', 0, 1001)).toBe('INV-1001');
    expect(formatInvoiceNumber('INV-', 5, 12)).toBe('INV-00012');
    expect(formatInvoiceNumber('', 0, 7)).toBe('7');
  });

  it('prefix must be empty or end in a non-digit', () => {
    expect(isValidPrefix('')).toBe(true);
    expect(isValidPrefix('INV-')).toBe(true);
    expect(isValidPrefix('2026/')).toBe(true);
    expect(isValidPrefix('INV1')).toBe(false);
    expect(isValidPrefix('A B-')).toBe(false);
    expect(isValidPrefix('ABCDEFGHIJKL-')).toBe(false);
  });

  it('allocate locks, returns the current number and advances the counter', async () => {
    const { prisma, seqs, mock } = makeFakePrisma();
    const service = new InvoiceNumberingService(prisma);
    const a = await service.allocate(prisma, PROFILE_ID, 'INVOICE');
    const b = await service.allocate(prisma, PROFILE_ID, 'INVOICE');
    expect([a, b]).toEqual([
      { sequence_number: 1001, number: '1001' },
      { sequence_number: 1002, number: '1002' },
    ]);
    expect(seqs.INVOICE).toMatchObject({ next_number: 1003, issued_count: 2 });
    const sql = (mock.$queryRaw.mock.calls[0][0] as unknown as string[]).join(
      '?',
    );
    expect(sql).toContain('FOR UPDATE');
  });

  it('next_number is editable only while nothing was issued; prefix any time', async () => {
    const { prisma, seqs } = makeFakePrisma();
    const service = new InvoiceNumberingService(prisma);
    await service.updateNumbering(PROFILE_ID, {
      invoice: { prefix: 'INV-', next_number: 5000, padding: 6 },
    });
    expect(seqs.INVOICE).toMatchObject({
      prefix: 'INV-',
      next_number: 5000,
      start_number: 5000,
      padding: 6,
    });
    const n = await service.allocate(prisma, PROFILE_ID, 'INVOICE');
    expect(n.number).toBe('INV-005000');

    expect(
      await codeOf(
        service.updateNumbering(PROFILE_ID, { invoice: { next_number: 1 } }),
      ),
    ).toBe('INVOICE_SEQUENCE_LOCKED');
    // Re-sending the current value is not a change.
    await service.updateNumbering(PROFILE_ID, {
      invoice: { next_number: 5001, prefix: 'F-' },
    });
    expect(seqs.INVOICE.prefix).toBe('F-');
    // The credit-note series is independent.
    await service.updateNumbering(PROFILE_ID, {
      credit_note: { next_number: 50 },
    });
    expect(seqs.CREDIT_NOTE.next_number).toBe(50);
  });

  it('rejects a prefix ending in a digit', async () => {
    const { prisma } = makeFakePrisma();
    const service = new InvoiceNumberingService(prisma);
    expect(
      await codeOf(
        service.updateNumbering(PROFILE_ID, { invoice: { prefix: 'INV1' } }),
      ),
    ).toBe('INVOICE_NUMBERING_INVALID');
  });
});
