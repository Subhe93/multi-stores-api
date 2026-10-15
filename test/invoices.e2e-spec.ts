import { execSync } from 'child_process';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { InvoicesService } from '../src/modules/invoices/invoices.service';
import { InvoiceNumberingService } from '../src/modules/invoices/invoice-numbering.service';
import { LegalProfileService } from '../src/modules/invoices/legal-profile.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { StoreAppsService } from '../src/modules/store-apps/store-apps.service';
import type { InvoicePdfService } from '../src/modules/invoices/pdf/invoice-pdf.service';
import { TaxManagementService } from '../src/modules/taxes/tax-management.service';
import type { TaxService } from '../src/modules/taxes/tax.service';

// Gaplessness and the database guards need a real PostgreSQL (mocks cannot
// prove FOR UPDATE semantics). Opt-in: set INVOICE_E2E_DATABASE_URL to a
// throwaway schema, e.g.
//   INVOICE_E2E_DATABASE_URL="postgresql://postgres@localhost:5433/multi_stores?schema=invoices_e2e&connection_limit=20"
//   npm run test:e2e -- invoices
// Each run creates its own fresh schema (`<schema>_<timestamp>`) with
// `prisma db push` (nothing existing is touched or reset), applies
// prisma/sql/invoice-guards.sql on top and drops that schema afterwards.

const BASE_URL = process.env.INVOICE_E2E_DATABASE_URL;
const d = BASE_URL ? describe : describe.skip;

function runUrl(base: string): { url: string; schema: string } {
  const u = new URL(base);
  const schema = `${u.searchParams.get('schema') || 'invoices_e2e'}_${Date.now()}`;
  u.searchParams.set('schema', schema);
  return { url: u.toString(), schema };
}

const ROOT = path.join(__dirname, '..');
const N = 50;

d('invoices (real database)', () => {
  let prisma: PrismaClient;
  let service: InvoicesService;
  let numbering: InvoiceNumberingService;
  let storeId: string;
  let orderIds: string[];
  const run = BASE_URL ? runUrl(BASE_URL) : { url: '', schema: '' };

  beforeAll(async () => {
    const env = { ...process.env, DATABASE_URL: run.url };
    execSync('npx prisma db push --skip-generate', {
      cwd: ROOT,
      env,
      stdio: 'pipe',
    });
    execSync(
      `npx prisma db execute --file prisma/sql/invoice-guards.sql --schema prisma/schema.prisma`,
      { cwd: ROOT, env, stdio: 'pipe' },
    );

    prisma = new PrismaClient({ datasourceUrl: run.url });
    const user = await prisma.user.create({
      data: { email: 'creator@e2e.test', password_hash: 'x', role: 'CREATOR' },
    });
    const creator = await prisma.creator.create({
      data: { user_id: user.id, display_name: 'E2E' },
    });
    const store = await prisma.store.create({
      data: {
        creator_id: creator.id,
        slug: 'e2e',
        name: 'E2E',
        store_type: 'INDEPENDENT',
      },
    });
    storeId = store.id;
    const custUser = await prisma.user.create({
      data: { email: 'cust@e2e.test', password_hash: 'x', role: 'CUSTOMER' },
    });
    const customer = await prisma.customer.create({
      data: { user_id: custUser.id, first_name: 'Anna', last_name: 'S' },
    });
    const address = await prisma.address.create({
      data: {
        customer_id: customer.id,
        full_name: 'Anna S',
        line1: 'Gatan 2',
        city: 'Stockholm',
        postal_code: '11123',
        country_code: 'SE',
      },
    });
    orderIds = [];
    for (let i = 0; i < N + 2; i++) {
      const o = await prisma.order.create({
        data: {
          order_number: `E2E-${i}`,
          customer_id: customer.id,
          address_id: address.id,
          store_id: storeId,
          status: 'CONFIRMED',
          subtotal: 125,
          total: 125,
          currency: 'SEK',
          payment_method: 'STRIPE',
          payment_status: 'paid',
          tax_rate_bp: 2500,
          tax_amount: 25,
          tax_lines: [
            {
              label: 'Moms',
              rate_bp: 2500,
              taxable_amount: 100,
              tax_amount: 25,
            },
          ],
          items: {
            create: {
              quantity: 1,
              unit_price: 125,
              total_price: 125,
              tax_rate_bp: 2500,
              tax_amount: 25,
              fulfiller_type: 'CREATOR',
              fulfiller_id: creator.id,
            },
          },
        },
      });
      orderIds.push(o.id);
    }

    const db = prisma as unknown as PrismaService;
    numbering = new InvoiceNumberingService(db);
    const profiles = new LegalProfileService(db, numbering);
    await profiles.upsert(storeId, {
      legal_name: 'E2E AB',
      org_number: '556036-0793',
      vat_number: 'SE556036079301',
      address_line1: 'Storgatan 1',
      postal_code: '11122',
      city: 'Stockholm',
      country_code: 'SE',
      bankgiro: '5050-1055',
    });
    await profiles.updateNumbering(storeId, {
      invoice: { prefix: 'INV-', next_number: 1001 },
    });
    service = new InvoicesService(
      db,
      { isEnabled: () => Promise.resolve(true) } as unknown as StoreAppsService,
      profiles,
      numbering,
      {} as InvoicePdfService,
    );
  }, 120_000);

  afterAll(async () => {
    // Only the schema this run created above.
    await prisma?.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${run.schema}" CASCADE`,
    );
    await prisma?.$disconnect();
  });

  it('(a) N parallel issues + duplicates → contiguous numbers, one per order', async () => {
    const targets = orderIds.slice(0, N);
    const dupes = targets.slice(0, 10);
    const results = await Promise.all(
      [...targets, ...dupes].map((id) =>
        service.issueForOrder(id, { trigger: 'MANUAL' }),
      ),
    );
    const byOrder = new Map<string, Set<string>>();
    for (const r of results) {
      const set = byOrder.get(r.invoice.order_id) ?? new Set();
      set.add(r.invoice.id);
      byOrder.set(r.invoice.order_id, set);
    }
    expect([...byOrder.values()].every((s) => s.size === 1)).toBe(true);
    const rows = await prisma.invoice.findMany({
      where: { store_id: storeId, kind: 'INVOICE' },
      orderBy: { sequence_number: 'asc' },
    });
    expect(rows).toHaveLength(N);
    expect(rows.map((r) => r.sequence_number)).toEqual(
      Array.from({ length: N }, (_, i) => 1001 + i),
    );
    expect(rows[0].number).toBe('INV-1001');
    expect(results.filter((r) => r.created)).toHaveLength(N);
  }, 120_000);

  it('(b) a failure after allocation leaves no gap', async () => {
    const original = (
      ...args: Parameters<InvoiceNumberingService['consume']>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Function.prototype.apply is untyped here
    ) => InvoiceNumberingService.prototype.consume.apply(numbering, args);
    const spy = jest
      .spyOn(numbering, 'consume')
      .mockImplementationOnce(async (tx, seq) => {
        await original(tx, seq);
        throw new Error('boom after allocate');
      });
    await expect(
      service.issueForOrder(orderIds[N], { trigger: 'MANUAL' }),
    ).rejects.toThrow('boom after allocate');
    spy.mockRestore();
    const next = await service.issueForOrder(orderIds[N], {
      trigger: 'MANUAL',
    });
    expect(next.invoice.sequence_number).toBe(1001 + N);
  }, 60_000);

  it('(c) the guards refuse UPDATE of the snapshot and DELETE; pdf_path is writable', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { store_id: storeId, kind: 'INVOICE' },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Invoice" SET snapshot = '{}'::jsonb WHERE id = $1`,
        inv.id,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "Invoice" WHERE id = $1`, inv.id),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      prisma.invoice.update({
        where: { id: inv.id },
        data: { pdf_path: 'x/y.pdf', emailed_at: new Date() },
      }),
    ).resolves.toMatchObject({ pdf_path: 'x/y.pdf' });
    // A second INVOICE for the same order is refused by the partial index.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Invoice" (id, store_id, legal_profile_id, order_id, kind, sequence_number, number, trigger, idempotency_key, issue_date, currency, locale, net_total, vat_total, gross_total, paid, buyer_name, order_number, snapshot, snapshot_sha256)
         SELECT gen_random_uuid(), store_id, legal_profile_id, order_id, kind, 999999, 'DUP', trigger, 'dup', issue_date, currency, locale, net_total, vat_total, gross_total, paid, buyer_name, order_number, snapshot, snapshot_sha256 FROM "Invoice" WHERE id = $1`,
        inv.id,
      ),
    ).rejects.toThrow(/23505|Key \(order_id\)/);
  }, 60_000);

  it('(d) concurrent credit-note replays → one credit per key, never above the invoice', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { store_id: storeId, kind: 'INVOICE', order_id: orderIds[1] },
    });
    const replay = Array.from({ length: 5 }, () =>
      service.issueCreditNote(inv.id, {
        amount: { refundCumulative: 30 },
        trigger: 'REFUND',
        idempotencyKey: `refund:${inv.order_id}:3000`,
      }),
    );
    const competing = () =>
      Array.from({ length: 5 }, (_, i) =>
        service
          .issueCreditNote(inv.id, {
            amount: 'full',
            trigger: 'MANUAL',
            idempotencyKey: `manual-${i}`,
          })
          .catch((e: unknown) => e),
      );
    const replayed = await Promise.all(replay);
    await Promise.all(competing());
    const replayIds = new Set(replayed.map((r) => r.invoice.id));
    expect(replayIds.size).toBe(1);
    const creditRows = await prisma.invoice.findMany({
      where: { credited_invoice_id: inv.id },
    });
    const credited = creditRows.reduce((s, c) => s - Number(c.gross_total), 0);
    expect(credited).toBeLessThanOrEqual(Number(inv.gross_total));
    expect(
      creditRows.filter((c) => c.idempotency_key.startsWith('refund:')),
    ).toHaveLength(1);
    const numbers = creditRows
      .map((c) => c.sequence_number)
      .sort((a, b) => a - b);
    expect(numbers).toEqual(
      Array.from({ length: numbers.length }, (_, i) => numbers[0] + i),
    );
  }, 60_000);
  it('(e) b2b M2.5: an RC invoice + credit note carry the exemption columns and feed the EC sales list', async () => {
    const order = await prisma.order.findFirstOrThrow({
      where: { id: orderIds[N + 1] },
      select: { customer_id: true, address_id: true },
    });
    const deAddress = await prisma.address.create({
      data: {
        customer_id: order.customer_id,
        full_name: 'Max Muster',
        line1: 'Musterstr. 1',
        city: 'Berlin',
        postal_code: '10115',
        country_code: 'DE',
        company_name: 'Muster GmbH',
      },
    });
    const rc = await prisma.order.create({
      data: {
        order_number: 'E2E-RC',
        customer_id: order.customer_id,
        address_id: deAddress.id,
        store_id: storeId,
        status: 'CONFIRMED',
        subtotal: 100,
        total: 100,
        currency: 'SEK',
        payment_method: 'KUSTOM',
        payment_status: 'paid',
        tax_rate_bp: 0,
        tax_amount: 0,
        tax_lines: [
          {
            label: 'Omvänd skattskyldighet',
            rate_bp: 0,
            taxable_amount: 100,
            tax_amount: 0,
            exempt_reason: 'REVERSE_CHARGE',
          },
        ],
        customer_type: 'COMPANY',
        company_name: 'Muster GmbH',
        org_number: 'HRB 1',
        vat_number: 'DE123456789',
        tax_exempt_reason: 'REVERSE_CHARGE',
        vat_validation: {
          source: 'VIES',
          vat_number: 'DE123456789',
          country_code: 'DE',
          status: 'valid',
          valid: true,
          name: 'Muster GmbH',
          address: null,
          request_identifier: 'WAPI-1',
          requester: 'SE556036079301',
          checked_at: '2026-10-15T09:12:00.000Z',
          check_id: null,
          destination_country: 'DE',
        },
        items: {
          create: {
            quantity: 1,
            unit_price: 100,
            total_price: 100,
            tax_rate_bp: 0,
            tax_amount: 0,
            fulfiller_type: 'CREATOR',
            fulfiller_id: 'x',
          },
        },
      },
    });
    const { invoice } = await service.issueForOrder(rc.id, {
      trigger: 'MANUAL',
    });
    expect(invoice).toMatchObject({
      tax_exempt_reason: 'REVERSE_CHARGE',
      buyer_vat_number: 'DE123456789',
      buyer_country: 'DE',
    });
    expect(Number(invoice.vat_total)).toBe(0);
    const credit = await service.issueCreditNote(invoice.id, {
      amount: 30,
      trigger: 'REFUND',
      idempotencyKey: 'rc-refund-1',
    });
    expect(credit.invoice).toMatchObject({
      kind: 'CREDIT_NOTE',
      tax_exempt_reason: 'REVERSE_CHARGE',
      buyer_vat_number: 'DE123456789',
      buyer_country: 'DE',
    });
    // The columns are immutable like the rest of the row.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Invoice" SET buyer_vat_number = 'DE000000000' WHERE id = $1`,
        invoice.id,
      ),
    ).rejects.toThrow(/immutable/);

    const taxes = new TaxManagementService(
      prisma as unknown as PrismaService,
      {} as TaxService,
      { isEnabled: () => Promise.resolve(true) } as unknown as StoreAppsService,
    );
    // issue_date is the seller-timezone day: query a window around now.
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const report = await taxes.ecSalesReport(
      { from: day(-1), to: day(1), period: 'month' },
      { store_id: storeId },
    );
    expect(report.source).toBe('invoices');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      buyer_country: 'DE',
      buyer_vat_number: 'DE123456789',
      buyer_name: 'Muster GmbH',
      goods_amount: 70,
      currency: 'SEK',
      goods_amount_store_currency: 70,
      document_count: 2,
    });
  }, 60_000);
});
