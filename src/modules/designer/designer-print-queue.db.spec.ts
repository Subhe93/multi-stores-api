/*
 * DB-backed print queue (M4.2 §5.3) against the local dev Postgres: the
 * claim SQL (`FOR UPDATE SKIP LOCKED`, the PENDING next-attempt gate, the
 * app gate, the terminal gate), `process` outcomes and `releaseInflight`
 * with real rows.
 *
 * Skipped without DATABASE_URL. Creates its own user / customer / creator /
 * store ("designer-queue-spec-<random>") with the designer app on, one
 * order with two designed items, and deletes everything it created in
 * afterAll (store cascades; orders have no FK and are deleted explicitly).
 * It never reads or writes rows of other stores.
 *
 * The queue walk runs inside ONE interactive transaction that first locks
 * the spec's rows `FOR UPDATE`: a print worker of another API instance on
 * the same database (the dev server) skips locked rows, so it can never
 * claim them between steps, while the service under test, built on the
 * transaction client, holds the locks itself.
 */
import { randomUUID } from 'crypto';
import { DesignPrintStatus, Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { DesignerPrintQueueService } from './designer-print-queue.service';
import type { DesignerRenderService } from './designer-render.service';
import { DesignerRenderUnavailableError } from './render/designer-chromium.host';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

jest.setTimeout(60_000);

describeDb('DesignerPrintQueueService (local Postgres)', () => {
  const prisma = new PrismaClient();
  const tag = randomUUID().slice(0, 8);
  let userIds: string[] = [];
  let orderId = '';
  let storeId = '';
  let rowIds: string[] = [];

  const render = {
    renderPrint: jest.fn(),
    orderProofPath: jest.fn(() => null),
    probeEngine: jest.fn(() => Promise.resolve()),
  };
  const storage = {
    read: jest.fn(() => Promise.resolve(null)),
    delete: jest.fn(() => Promise.resolve()),
  };
  /**
   * The service under test with its worker OFF: `enqueueOrder` nudges a
   * tick otherwise, which would claim and process rows on this very
   * transaction concurrently with the walk below. claimNext / process /
   * releaseInflight do not depend on the worker flag.
   */
  const queue = (db: Prisma.TransactionClient | PrismaClient) => {
    const saved = { ...process.env };
    process.env.DESIGNER_RENDER_QUEUE = 'off';
    delete process.env.DESIGNER_WORKER;
    delete process.env.DESIGNER_RENDER_ENGINE;
    const q = new DesignerPrintQueueService(
      db as unknown as PrismaService,
      render as unknown as DesignerRenderService,
      storage as never,
    );
    process.env = saved;
    return q;
  };

  beforeAll(async () => {
    const customerUser = await prisma.user.create({
      data: {
        email: `designer-queue-spec-${tag}-c@example.invalid`,
        password_hash: 'x',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        customer: { create: { first_name: 'Spec', last_name: 'Customer' } },
      },
      include: { customer: true },
    });
    const creatorUser = await prisma.user.create({
      data: {
        email: `designer-queue-spec-${tag}-s@example.invalid`,
        password_hash: 'x',
        role: 'CREATOR',
        status: 'ACTIVE',
        creator: {
          create: {
            display_name: `designer-queue-spec-${tag}`,
            store: {
              create: {
                slug: `designer-queue-spec-${tag}`,
                name: 'Designer queue spec',
                apps: {
                  create: {
                    app_key: 'designer',
                    available: true,
                    enabled: true,
                  },
                },
              },
            },
          },
        },
      },
      include: { creator: { include: { store: true } } },
    });
    userIds = [customerUser.id, creatorUser.id];
    storeId = creatorUser.creator!.store!.id;
    const customer = customerUser.customer!;
    const address = await prisma.address.create({
      data: {
        customer_id: customer.id,
        full_name: 'Spec Customer',
        line1: 'Testgatan 1',
        city: 'Stockholm',
        postal_code: '11122',
        country_code: 'SE',
      },
    });
    const order = await prisma.order.create({
      data: {
        order_number: `DQS-${tag}`,
        customer_id: customer.id,
        address_id: address.id,
        store_id: storeId,
        status: 'CONFIRMED',
        subtotal: 10,
        total: 10,
        payment_method: 'COD',
        payment_status: 'pending',
        items: {
          create: [1, 2].map((n) => ({
            quantity: 1,
            unit_price: 5,
            total_price: 5,
            fulfiller_type: 'CREATOR',
            fulfiller_id: creatorUser.creator!.id,
            design: {
              create: {
                order_id: '', // set below (no relation from design to order)
                store_id: storeId,
                template_id: randomUUID(),
                template_version_id: randomUUID(),
                template_spec: { n },
                state: { v: 1, texts: {}, photos: {} },
                assets: [],
                text_values: [],
                price_breakdown: { designer_delta: 0, addons: [] },
                renderer_version: '1.1.0',
              },
            },
          })),
        },
      },
      include: { items: { include: { design: true } } },
    });
    orderId = order.id;
    rowIds = order.items.map((i) => i.design!.id);
    await prisma.orderItemDesign.updateMany({
      where: { id: { in: rowIds } },
      data: { order_id: orderId },
    });
  });

  afterAll(async () => {
    if (orderId) {
      await prisma.order.deleteMany({ where: { id: orderId } }); // items + designs cascade
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // customer, creator, store, apps cascade
    }
    await prisma.$disconnect();
  });

  it('claim / handback / process / release / terminal gate on real rows (one locked transaction)', async () => {
    await prisma.$transaction(
      async (tx) => {
        // Lock the spec's rows for the whole walk: other instances skip them.
        await tx.$queryRaw`SELECT id FROM "OrderItemDesign" WHERE id IN (${Prisma.join(rowIds)}) FOR UPDATE`;
        const q = queue(tx);
        const rows = () =>
          tx.orderItemDesign.findMany({
            where: { id: { in: rowIds } },
            orderBy: { created_at: 'asc' },
          });
        const otherRendering = () =>
          tx.orderItemDesign.count({
            where: {
              store_id: { not: storeId },
              print_status: DesignPrintStatus.RENDERING,
            },
          });

        // Nothing is claimable until the order is requested; enqueue is idempotent.
        expect(await q.claimNext()).toBeNull();
        expect(await q.enqueueOrder(orderId)).toBe(2);
        expect(await q.enqueueOrder(orderId)).toBe(0);
        expect(
          (await rows()).every(
            (x) => x.print_requested_at && x.print_status === 'PENDING',
          ),
        ).toBe(true);

        // claimNext: one row of this store, RENDERING, attempt 1, locked;
        // rows of other stores are never touched.
        const before = await otherRendering();
        const claimed = (await q.claimNext())!;
        expect(claimed).not.toBeNull();
        expect(rowIds).toContain(claimed.id);
        expect(claimed).toMatchObject({
          store_id: storeId,
          order_id: orderId,
          print_attempts: 1,
        });
        expect(claimed.print_locked_at).toBeInstanceOf(Date);
        expect(await otherRendering()).toBe(before);

        // releaseInflight hands it back, fenced by the lock timestamp.
        (q as unknown as { inflight: Map<string, Date | null> }).inflight.set(
          claimed.id,
          claimed.print_locked_at,
        );
        expect(await q.releaseInflight()).toBe(1);
        expect(
          await tx.orderItemDesign.findUnique({ where: { id: claimed.id } }),
        ).toMatchObject({
          print_status: 'PENDING',
          print_attempts: 0,
          print_locked_at: null,
        });
        // A stale fence (another worker reclaimed meanwhile) releases nothing.
        (q as unknown as { inflight: Map<string, Date | null> }).inflight.set(
          claimed.id,
          new Date(0),
        );
        expect(await q.releaseInflight()).toBe(0);

        // process: DESIGNER_RENDER_UNAVAILABLE hands the row back without an
        // attempt, due after the pause; the claim honours that gate.
        render.renderPrint.mockRejectedValueOnce(
          new DesignerRenderUnavailableError('no browser'),
        );
        const first = (await q.claimNext())!;
        await q.process(first);
        const back = (await tx.orderItemDesign.findUnique({
          where: { id: first.id },
        }))!;
        expect(back.print_status).toBe('PENDING');
        expect(back.print_attempts).toBe(0);
        expect(back.print_error).toBeNull();
        expect(back.print_next_attempt_at!.getTime()).toBeGreaterThan(
          Date.now(),
        );
        const second = (await q.claimNext())!;
        expect(second.id).not.toBe(first.id);
        expect(await q.claimNext()).toBeNull(); // the handed-back row is gated
        await tx.orderItemDesign.update({
          where: { id: first.id },
          data: { print_next_attempt_at: new Date(Date.now() - 1000) },
        });
        const again = (await q.claimNext())!;
        expect(again.id).toBe(first.id);
        expect(again.print_attempts).toBe(1);

        // Outcomes: a success (READY, lock cleared) and a retryable failure
        // (FAILED, attempt kept, backoff set).
        render.renderPrint.mockResolvedValueOnce({
          files: [
            {
              surface: 'front',
              format: 'png',
              key: `designer/${storeId}/2026/print/${second.id}-front.png`,
              width_px: 3000,
              height_px: 4200,
              dpi: 152.4,
              bytes: 1,
              sha256: 'a',
            },
          ],
          proof_key: null,
          report: { fitted: {}, missing: [], elements: 0 },
        });
        await q.process(second);
        render.renderPrint.mockRejectedValueOnce(new Error('page crashed'));
        await q.process(again);
        const byId = new Map((await rows()).map((x) => [x.id, x]));
        expect(byId.get(second.id)).toMatchObject({
          print_status: 'READY',
          print_locked_at: null,
        });
        expect(byId.get(again.id)).toMatchObject({
          print_status: 'FAILED',
          print_attempts: 1,
          print_error: 'DESIGNER_RENDER_FAILED: page crashed',
        });
        expect(
          byId.get(again.id)!.print_next_attempt_at!.getTime(),
        ).toBeGreaterThan(Date.now());

        // A terminal order is never claimed, even when due.
        await tx.orderItemDesign.updateMany({
          where: { id: { in: rowIds } },
          data: { print_next_attempt_at: new Date(Date.now() - 1000) },
        });
        expect(await q.cancelOrder(orderId)).toBe(2);
        expect(await q.claimNext()).toBeNull();
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  });
});
