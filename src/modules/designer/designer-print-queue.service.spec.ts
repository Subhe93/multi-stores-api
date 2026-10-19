import { readFileSync } from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { DesignPrintStatus } from '@prisma/client';
import { printFormatParam } from './designer-templates.controller';
import {
  backoffMs,
  DesignerPrintQueueService,
  isOwnPrintKey,
  PRINT_JOB_TIMEOUT_MS,
  PRINT_MAX_ATTEMPTS,
  PRINT_RENDER_PAUSE_MS,
  printQueueConfig,
  type ClaimedRow,
} from './designer-print-queue.service';
import { DesignerRenderJobError } from './designer-render.service';
import { DesignerRenderUnavailableError } from './render/designer-chromium.host';

const STORE = '11111111-1111-4111-8111-111111111111';
const LOCK = new Date('2026-10-16T10:00:00Z');
const NOW = new Date('2026-10-16T10:00:05Z');
const OID = 'cccccccc-0000-4000-8000-000000000001';

const row = (over: Partial<ClaimedRow> = {}): ClaimedRow => ({
  id: 'oid1',
  store_id: STORE,
  order_id: 'o1',
  template_spec: {},
  state: {},
  proof_key: null,
  files_purged_at: null,
  originals_purged_at: null,
  print_attempts: 1,
  print_locked_at: LOCK,
  ...over,
});

const files = [
  {
    surface: 'front' as const,
    format: 'png' as const,
    key: 'designer/k.png',
    width_px: 3000,
    height_px: 4200,
    dpi: 152.4,
    bytes: 10,
    sha256: 'abc',
  },
];

function build(env: NodeJS.ProcessEnv = {}) {
  const saved = { ...process.env };
  for (const k of [
    'DESIGNER_RENDER_QUEUE',
    'DESIGNER_WORKER',
    'DESIGNER_RENDER_ENGINE',
    'DESIGNER_RENDER_CONCURRENCY',
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  const prisma = {
    $queryRaw: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    orderItemDesign: {
      // The "cancelled meanwhile" probe (`terminal_at: {not: null}`) matches
      // nothing unless a test says otherwise.
      updateMany: jest.fn((a?: { where?: { terminal_at?: unknown } }) =>
        Promise.resolve({
          count:
            a?.where?.terminal_at && typeof a.where.terminal_at === 'object'
              ? 0
              : 1,
        }),
      ),
      findFirst: jest.fn(),
      // The row as re-read after a lost fence (lists nothing by default).
      findUnique: jest.fn(
        (): Promise<{ print_files: unknown } | null> =>
          Promise.resolve({ print_files: null }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
    },
    design: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      count: jest.fn(() => Promise.resolve(0)),
    },
    storeLanguageConfig: {
      findUnique: jest.fn(() => Promise.resolve({ primary_locale: 'sv' })),
    },
  };
  const render = {
    renderPrint: jest.fn(() =>
      Promise.resolve({
        files,
        proof_key: 'designer/proof.webp' as string | null,
        report: { fitted: {}, missing: [], elements: 1 },
      }),
    ),
    orderProofPath: jest.fn(() => '/api/designer/files/t'),
    probeEngine: jest.fn(() => Promise.resolve()),
  };
  const storage = {
    read: jest.fn(() => Promise.resolve(Buffer.from('png'))),
    delete: jest.fn(() => Promise.resolve()),
  };
  const queue = new DesignerPrintQueueService(
    prisma as never,
    render as never,
    storage as never,
  );
  process.env = saved;
  return { queue, prisma, render, storage };
}

afterEach(() => jest.useRealTimers());

/** updateMany calls of the outcome write (not the cancelled-order probe). */
function outcomeCalls(b: ReturnType<typeof build>) {
  return (
    b.prisma.orderItemDesign.updateMany.mock.calls as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ][]
  ).filter((c) => !('terminal_at' in c[0].where));
}

describe('printQueueConfig (env flags)', () => {
  it('on by default with concurrency 1', () => {
    expect(printQueueConfig({})).toEqual({ enabled: true, concurrency: 1 });
    expect(
      printQueueConfig({ DESIGNER_RENDER_CONCURRENCY: '2' }).concurrency,
    ).toBe(2);
    expect(
      printQueueConfig({ DESIGNER_RENDER_CONCURRENCY: '8' }).concurrency,
    ).toBe(1);
  });

  it.each([
    ['DESIGNER_RENDER_QUEUE', 'off'],
    ['DESIGNER_WORKER', 'off'],
    ['DESIGNER_RENDER_ENGINE', 'off'],
    ['DESIGNER_RENDER_QUEUE', 'false'],
  ])('%s=%s disables the worker', (k, v) => {
    expect(printQueueConfig({ [k]: v }).enabled).toBe(false);
  });
});

describe('DesignerPrintQueueService — worker disabled', () => {
  it('DESIGNER_RENDER_QUEUE=off: no interval, tick/nudge do nothing', async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'setInterval');
    const b = build({ DESIGNER_RENDER_QUEUE: 'off' });
    b.queue.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    b.queue.nudge();
    await b.queue.tick();
    jest.advanceTimersByTime(60_000);
    expect(b.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(b.render.renderPrint).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('enqueue still records the request (another instance renders)', async () => {
    const b = build({ DESIGNER_RENDER_QUEUE: 'off' });
    await expect(b.queue.enqueueOrder('o1', NOW)).resolves.toBe(1);
  });
});

describe('DesignerPrintQueueService — producer', () => {
  it('enqueueOrder is idempotent: only unrequested, non-terminal, unpurged PENDING/FAILED rows', async () => {
    const b = build();
    const nudge = jest.spyOn(b.queue, 'nudge').mockImplementation(() => {});
    await b.queue.enqueueOrder('o1', NOW);
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenCalledWith({
      where: {
        order_id: 'o1',
        print_requested_at: null,
        files_purged_at: null,
        terminal_at: null,
        print_status: {
          in: [DesignPrintStatus.PENDING, DesignPrintStatus.FAILED],
        },
      },
      data: {
        print_requested_at: NOW,
        print_status: DesignPrintStatus.PENDING,
        print_attempts: 0,
        print_next_attempt_at: null,
        print_error: null,
      },
    });
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('an order without designs (or already queued) updates nothing and does not nudge', async () => {
    const b = build();
    b.prisma.orderItemDesign.updateMany.mockResolvedValue({ count: 0 });
    const nudge = jest.spyOn(b.queue, 'nudge');
    await expect(b.queue.enqueueOrder('o1')).resolves.toBe(0);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('cancelOrder marks terminal and withdraws pending requests', async () => {
    const b = build();
    await b.queue.cancelOrder('o1', NOW);
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenNthCalledWith(1, {
      where: { order_id: 'o1', terminal_at: null },
      data: { terminal_at: NOW },
    });
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        order_id: 'o1',
        print_status: {
          in: [DesignPrintStatus.PENDING, DesignPrintStatus.FAILED],
        },
        print_requested_at: { not: null },
      },
      data: { print_requested_at: null, print_next_attempt_at: null },
    });
  });

  it('markShipped only fills a missing shipped_at', async () => {
    const b = build();
    await b.queue.markShipped('o1', NOW);
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenCalledWith({
      where: { order_id: 'o1', shipped_at: null },
      data: { shipped_at: NOW },
    });
  });
});

describe('DesignerPrintQueueService — job lifecycle', () => {
  it('claim SQL: due rows only, stale-lock reclaim, app in effect, SKIP LOCKED', async () => {
    const b = build();
    await b.queue.claimNext();
    const sql = (b.prisma.$queryRaw.mock.calls[0] as unknown[])[0] as {
      strings: string[];
      values: unknown[];
    };
    const text = sql.strings.join('?');
    expect(text).toContain("SET print_status = 'RENDERING'");
    expect(text).toContain('print_attempts = print_attempts + 1');
    expect(text).toContain('print_requested_at IS NOT NULL');
    expect(text).toContain('files_purged_at IS NULL');
    expect(text).toContain("o.print_status = 'FAILED'");
    expect(text).toContain('print_next_attempt_at <= now()');
    expect(text).toContain("interval '10 minutes'");
    expect(text).toContain("sa.app_key = 'designer'");
    expect(text).toContain('sa.available AND sa.enabled');
    expect(text).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(sql.values).toContain(PRINT_MAX_ATTEMPTS);
  });

  it('PENDING → RENDERING → READY: files, proof and a lock-fenced update', async () => {
    const b = build();
    await b.queue.process(row(), () => NOW);
    expect(b.render.renderPrint).toHaveBeenCalledWith(row());
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'oid1',
        print_status: DesignPrintStatus.RENDERING,
        print_locked_at: LOCK,
      },
      data: {
        print_status: DesignPrintStatus.READY,
        print_files: files,
        print_rendered_at: NOW,
        print_error: null,
        print_next_attempt_at: null,
        print_locked_at: null,
        proof_key: 'designer/proof.webp',
      },
    });
  });

  it('READY deletes the previous files the new render no longer lists (PDF switched off)', async () => {
    const b = build();
    const png = `designer/${STORE}/2026/print/${OID}-front.png`;
    const pdf = `designer/${STORE}/2026/print/${OID}-front.pdf`;
    b.render.renderPrint.mockResolvedValueOnce({
      files: [{ ...files[0], key: png }],
      proof_key: null,
      report: { fitted: {}, missing: [], elements: 1 },
    });
    await b.queue.process(
      row({
        id: OID,
        print_files: [
          { ...files[0], key: png },
          { ...files[0], format: 'pdf', key: pdf },
        ] as never,
      }),
      () => NOW,
    );
    expect(b.storage.delete).toHaveBeenCalledTimes(1);
    expect(b.storage.delete).toHaveBeenCalledWith(pdf);
  });

  it("READY never deletes a listed key that is not this row's own print file", async () => {
    const b = build();
    const other = 'dddddddd-0000-4000-8000-000000000009';
    await b.queue.process(
      row({
        id: OID,
        print_files: [
          {
            ...files[0],
            key: `designer/${STORE}/2026/print/${other}-front.png`,
          },
          { ...files[0], key: `designer/${other}/2026/print/${OID}-front.pdf` },
          { ...files[0], key: `designer/${STORE}/2026/photo/${OID}.jpg` },
        ] as never,
      }),
      () => NOW,
    );
    expect(b.storage.delete).not.toHaveBeenCalled();
  });

  it('a lost fence deletes the new files, never the previous ones', async () => {
    const b = build();
    b.prisma.orderItemDesign.updateMany.mockResolvedValueOnce({ count: 0 });
    await b.queue.process(
      row({ print_files: [{ ...files[0], key: 'designer/old.png' }] as never }),
      () => NOW,
    );
    expect(b.storage.delete).toHaveBeenCalledWith('designer/k.png');
    expect(b.storage.delete).not.toHaveBeenCalledWith('designer/old.png');
  });

  it('a lost fence keeps the files the row lists now (same per-row key, reclaimed render READY)', async () => {
    const b = build();
    b.prisma.orderItemDesign.updateMany.mockResolvedValueOnce({ count: 0 });
    b.prisma.orderItemDesign.findUnique.mockResolvedValueOnce({
      print_files: files,
    });
    await b.queue.process(row(), () => NOW);
    expect(b.storage.delete).not.toHaveBeenCalledWith('designer/k.png');
  });

  it('a lost fence whose re-read fails keeps the files', async () => {
    const b = build();
    b.prisma.orderItemDesign.updateMany.mockResolvedValueOnce({ count: 0 });
    b.prisma.orderItemDesign.findUnique.mockRejectedValueOnce(new Error('db'));
    await b.queue.process(row(), () => NOW);
    expect(b.storage.delete).not.toHaveBeenCalledWith('designer/k.png');
  });

  it("isOwnPrintKey: only this row's print keys", () => {
    const r = { id: OID, store_id: STORE };
    expect(
      isOwnPrintKey(`designer/${STORE}/2025/print/${OID}-front.png`, r),
    ).toBe(true);
    expect(
      isOwnPrintKey(`designer/${STORE}/2025/print/${OID}-front.pdf`, r),
    ).toBe(true);
    expect(
      isOwnPrintKey(`designer/${STORE}/2025/print/../${OID}-front.pdf`, r),
    ).toBe(false);
    expect(isOwnPrintKey(`designer/${STORE}/2025/proof/${OID}.webp`, r)).toBe(
      false,
    );
    expect(isOwnPrintKey('designer/k.png', r)).toBe(false);
  });

  it('a retryable failure → FAILED with backoff 1 min, then 10 min', async () => {
    const b = build();
    b.render.renderPrint.mockRejectedValue(
      new DesignerRenderJobError(
        'Designer render timed out after 60000 ms',
        true,
      ),
    );
    await b.queue.process(row({ print_attempts: 1 }), () => NOW);
    await b.queue.process(row({ print_attempts: 2 }), () => NOW);
    const data = (i: number) => outcomeCalls(b)[i][0].data;
    expect(data(0)).toMatchObject({
      print_status: DesignPrintStatus.FAILED,
      print_locked_at: null,
      print_next_attempt_at: new Date(NOW.getTime() + 60_000),
    });
    expect(String(data(0).print_error)).toMatch(/^DESIGNER_RENDER_FAILED: /);
    expect(data(1).print_next_attempt_at).toEqual(
      new Date(NOW.getTime() + 10 * 60_000),
    );
    expect(data(0)).not.toHaveProperty('print_attempts');
  });

  it('the last attempt is final (no next attempt)', async () => {
    const b = build();
    b.render.renderPrint.mockRejectedValue(new Error('boom'));
    await b.queue.process(
      row({ print_attempts: PRINT_MAX_ATTEMPTS }),
      () => NOW,
    );
    const call = outcomeCalls(b)[0];
    expect(call[0].data).toMatchObject({
      print_status: DesignPrintStatus.FAILED,
      print_next_attempt_at: null,
    });
  });

  it('a deterministic failure is final at once (attempts set to MAX)', async () => {
    const b = build();
    b.render.renderPrint.mockRejectedValue(
      new DesignerRenderJobError('purged', false, 'DESIGNER_FILES_PURGED'),
    );
    await b.queue.process(row({ print_attempts: 1 }), () => NOW);
    const call = outcomeCalls(b)[0];
    expect(call[0].data).toMatchObject({
      print_status: DesignPrintStatus.FAILED,
      print_next_attempt_at: null,
      print_attempts: PRINT_MAX_ATTEMPTS,
      print_error: 'DESIGNER_FILES_PURGED: purged',
    });
  });

  it('a job over its timeout fails (retryable) and frees the worker', async () => {
    jest.useFakeTimers();
    const b = build();
    b.render.renderPrint.mockReturnValue(new Promise(() => undefined));
    const done = b.queue.process(row(), () => NOW);
    await jest.advanceTimersByTimeAsync(PRINT_JOB_TIMEOUT_MS + 1);
    await done;
    const call = outcomeCalls(b)[0];
    expect(call[0].data.print_status).toBe(DesignPrintStatus.FAILED);
    expect(String(call[0].data.print_error)).toMatch(/timed out/);
    expect(call[0].data.print_next_attempt_at).toEqual(
      new Date(NOW.getTime() + 60_000),
    );
  });

  it('DESIGNER_RENDER_UNAVAILABLE hands the row back (attempt not counted, due after the pause) and pauses this instance', async () => {
    jest.useFakeTimers({ now: NOW.getTime() });
    const b = build();
    b.render.renderPrint.mockRejectedValue(
      new DesignerRenderUnavailableError('Designer engine could not start'),
    );
    await b.queue.process(row({ print_attempts: 1 }), () => NOW);
    const calls = b.prisma.orderItemDesign.updateMany.mock.calls as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0].where).toEqual({
      id: 'oid1',
      print_status: DesignPrintStatus.RENDERING,
      print_locked_at: LOCK,
    });
    expect(calls[0][0].data).toEqual({
      print_status: DesignPrintStatus.PENDING,
      print_locked_at: null,
      print_attempts: { decrement: 1 },
      print_next_attempt_at: new Date(NOW.getTime() + PRINT_RENDER_PAUSE_MS),
    });
    // Never FAILED, never an error recorded on the row.
    expect(calls[0][0].data).not.toHaveProperty('print_error');
    expect(b.queue.pausedUntil).toBe(NOW.getTime() + PRINT_RENDER_PAUSE_MS);
    // While paused nothing is claimed; after the window claims resume.
    await b.queue.tick();
    expect(b.prisma.$queryRaw).not.toHaveBeenCalled();
    jest.setSystemTime(NOW.getTime() + PRINT_RENDER_PAUSE_MS);
    await b.queue.tick();
    expect(b.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('a pass probes the engine before its first claim; an engine that cannot start pauses without claiming', async () => {
    jest.useFakeTimers({ now: NOW.getTime() });
    const b = build();
    b.render.probeEngine.mockRejectedValueOnce(
      new DesignerRenderUnavailableError('Designer engine could not start'),
    );
    await b.queue.tick();
    expect(b.render.probeEngine).toHaveBeenCalledTimes(1);
    expect(b.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(b.queue.pausedUntil).toBe(NOW.getTime() + PRINT_RENDER_PAUSE_MS);
    // The sweep / backfill still ran (they need no browser).
    expect(b.prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('the claim honours print_next_attempt_at of a handed-back PENDING row', async () => {
    const b = build();
    await b.queue.claimNext();
    const sql = (b.prisma.$queryRaw.mock.calls[0] as unknown[])[0] as {
      strings: string[];
    };
    expect(sql.strings.join('?').replace(/\s+/g, ' ')).toContain(
      "(o.print_status = 'PENDING' AND (o.print_next_attempt_at IS NULL OR o.print_next_attempt_at <= now()))",
    );
  });

  it('tick drains claimed rows one at a time, then stops', async () => {
    const b = build();
    b.prisma.$queryRaw
      .mockResolvedValueOnce([row({ id: 'a' })])
      .mockResolvedValueOnce([row({ id: 'b' })])
      .mockResolvedValueOnce([]);
    await b.queue.tick();
    expect(b.render.renderPrint).toHaveBeenCalledTimes(2);
    // Abandoned sweep + the (throttled) backfill of unrequested paid rows.
    expect(b.prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(b.prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('tick never throws (DB down)', async () => {
    const b = build();
    b.prisma.$executeRaw.mockRejectedValue(new Error('db down'));
    await expect(b.queue.tick()).resolves.toBeUndefined();
  });

  it('backoffMs', () => {
    expect([1, 2, 3, 9].map(backoffMs)).toEqual([
      60_000, 600_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('DesignerPrintQueueService — creator routes', () => {
  const ready = {
    id: 'oid1',
    store_id: STORE,
    order_id: 'o1',
    print_status: DesignPrintStatus.READY,
    print_files: files,
    files_purged_at: null,
  };

  it('printFile streams the PNG with <order_number>-<n>-front.png', async () => {
    const b = build();
    b.prisma.orderItemDesign.findFirst.mockResolvedValue(ready);
    b.prisma.orderItemDesign.findMany.mockResolvedValue([
      { id: 'other', order_item: { order: { order_number: 'NZ-1001' } } },
      { id: 'oid1', order_item: { order: { order_number: 'NZ-1001' } } },
    ] as never);
    const out = await b.queue.printFile(STORE, 'o1', 'i1');
    expect(out.filename).toBe('NZ-1001-2-front.png');
    expect(b.storage.read).toHaveBeenCalledWith('designer/k.png');
    expect(b.prisma.orderItemDesign.findFirst).toHaveBeenCalledWith({
      where: { store_id: STORE, order_id: 'o1', order_item_id: 'i1' },
    });
  });

  it('printFile with format pdf streams the PDF; 409 when the render has none', async () => {
    const b = build();
    const pdf = {
      ...files[0],
      format: 'pdf' as const,
      key: 'designer/k.pdf',
      page_mm: { width: 506, height: 706 },
    };
    b.prisma.orderItemDesign.findFirst.mockResolvedValueOnce({
      ...ready,
      print_files: [...files, pdf],
    });
    b.prisma.orderItemDesign.findMany.mockResolvedValue([
      { id: 'oid1', order_item: { order: { order_number: 'NZ-1001' } } },
    ] as never);
    const out = await b.queue.printFile(STORE, 'o1', 'i1', 'pdf');
    expect(out).toMatchObject({
      filename: 'NZ-1001-1-front.pdf',
      mime: 'application/pdf',
    });
    expect(b.storage.read).toHaveBeenCalledWith('designer/k.pdf');
    b.prisma.orderItemDesign.findFirst.mockResolvedValueOnce(ready);
    await expect(
      b.queue.printFile(STORE, 'o1', 'i1', 'pdf'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('printFile: 409 not ready, 410 purged, 404 for another store', async () => {
    const b = build();
    b.prisma.orderItemDesign.findFirst.mockResolvedValueOnce({
      ...ready,
      print_status: DesignPrintStatus.PENDING,
      print_files: null,
    });
    await expect(b.queue.printFile(STORE, 'o1', 'i1')).rejects.toMatchObject({
      status: 409,
    });
    b.prisma.orderItemDesign.findFirst.mockResolvedValueOnce({
      ...ready,
      files_purged_at: NOW,
    });
    await expect(b.queue.printFile(STORE, 'o1', 'i1')).rejects.toMatchObject({
      status: 410,
    });
    b.prisma.orderItemDesign.findFirst.mockResolvedValueOnce(null);
    await expect(b.queue.printFile(STORE, 'o1', 'i1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('regenerateItem resets to PENDING with attempts 0 and nudges', async () => {
    const b = build();
    const nudge = jest.spyOn(b.queue, 'nudge').mockImplementation(() => {});
    b.prisma.orderItemDesign.findFirst.mockResolvedValue({
      ...ready,
      print_status: DesignPrintStatus.FAILED,
    });
    await expect(b.queue.regenerateItem(STORE, 'o1', 'i1')).resolves.toEqual({
      queued: true,
      print_status: DesignPrintStatus.PENDING,
    });
    const call = b.prisma.orderItemDesign.updateMany.mock
      .calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(call[0].where).toMatchObject({ id: 'oid1', store_id: STORE });
    expect(call[0].data).toMatchObject({
      print_status: DesignPrintStatus.PENDING,
      print_attempts: 0,
      print_error: null,
    });
    expect(nudge).toHaveBeenCalled();
  });

  it('list maps rows (low-res flag, proof url, no storage keys)', async () => {
    const b = build();
    b.prisma.orderItemDesign.count.mockResolvedValue(1);
    b.prisma.orderItemDesign.findMany.mockResolvedValue([
      {
        ...ready,
        order_item_id: 'i1',
        assets: [{ asset_id: 'x', low_res: true }],
        proof_key: 'designer/p.webp',
        print_attempts: 1,
        print_error: null,
        print_requested_at: NOW,
        print_rendered_at: NOW,
        print_next_attempt_at: null,
        created_at: NOW,
        order_item: {
          quantity: 1,
          product_id: 'p1',
          product: {
            translations: [
              { locale: 'en', title: 'Sign' },
              { locale: 'sv', title: 'Skylt' },
            ],
          },
          order: { order_number: 'NZ-1', status: 'PAID' },
        },
      },
    ] as never);
    const res = await b.queue.list(STORE, { status: DesignPrintStatus.READY });
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      order_number: 'NZ-1',
      product_id: 'p1',
      product_title: 'Skylt', // the store's primary locale
      low_res: true,
      proof_url: '/api/designer/files/t',
      max_attempts: PRINT_MAX_ATTEMPTS,
    });
    expect(res.items[0].print_files[0]).not.toHaveProperty('key');
  });

  it('list shows the PDF page geometry (never its key)', async () => {
    const b = build();
    b.prisma.orderItemDesign.count.mockResolvedValue(1);
    b.prisma.orderItemDesign.findMany.mockResolvedValue([
      {
        ...ready,
        print_files: [
          ...files,
          {
            ...files[0],
            format: 'pdf',
            key: 'designer/k.pdf',
            bytes: 2048,
            page_mm: { width: 506, height: 706 },
            trim_mm: { width: 500, height: 700 },
            bleed_mm: 3,
            crop_marks: false,
          },
        ],
        order_item_id: 'i1',
        assets: [],
        created_at: NOW,
        order_item: null,
      },
    ] as never);
    const res = await b.queue.list(STORE);
    const [png, pdf] = res.items[0].print_files;
    expect(png).not.toHaveProperty('page_mm');
    expect(pdf).toEqual({
      surface: 'front',
      format: 'pdf',
      width_px: 3000,
      height_px: 4200,
      dpi: 152.4,
      bytes: 2048,
      page_mm: { width: 506, height: 706 },
      trim_mm: { width: 500, height: 700 },
      bleed_mm: 3,
      crop_marks: false,
    });
  });
});

describe('DesignerPrintQueueService — lifecycle fixes (M4.2)', () => {
  const sqlOf = (m: jest.Mock, i = 0) => {
    const q = (m.mock.calls[i] as unknown[])[0] as {
      strings?: string[];
      sql?: string;
    };
    return (q.strings ?? [q.sql ?? '']).join('?');
  };

  it('the claim never takes a terminal row', async () => {
    const b = build();
    await b.queue.claimNext();
    expect(sqlOf(b.prisma.$queryRaw)).toMatch(/o\.terminal_at IS NULL/);
  });

  it('a render failing after the order was cancelled is final (no retry, request withdrawn)', async () => {
    const b = build();
    b.render.renderPrint.mockRejectedValue(new Error('boom'));
    b.prisma.orderItemDesign.updateMany.mockResolvedValueOnce({ count: 1 });
    await b.queue.process(row({ print_attempts: 1 }), () => NOW);
    const calls = b.prisma.orderItemDesign.updateMany.mock.calls as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ][];
    expect(calls).toHaveLength(1);
    expect(calls[0][0].where).toMatchObject({
      id: 'oid1',
      terminal_at: { not: null },
    });
    expect(calls[0][0].data).toMatchObject({
      print_status: DesignPrintStatus.FAILED,
      print_next_attempt_at: null,
      print_requested_at: null,
    });
  });

  it('regenerate / retry-all skip terminal rows; regenerateItem → 409 DESIGNER_ORDER_TERMINAL', async () => {
    const b = build();
    b.prisma.orderItemDesign.findFirst.mockResolvedValue({
      id: 'oid1',
      print_status: DesignPrintStatus.FAILED,
      files_purged_at: null,
      terminal_at: NOW,
    } as never);
    await expect(
      b.queue.regenerateItem(STORE, 'o1', 'i1'),
    ).rejects.toMatchObject({
      response: { code: 'DESIGNER_ORDER_TERMINAL' },
    });
    await b.queue.retryAllFailed(STORE, NOW);
    await b.queue.regenerate({ id: 'oid1', store_id: STORE }, NOW);
    for (const c of b.prisma.orderItemDesign.updateMany.mock
      .calls as unknown as [{ where: Record<string, unknown> }][]) {
      expect(c[0].where).toMatchObject({ terminal_at: null });
    }
  });

  it('main.ts enables the shutdown hooks before listen, so onModuleDestroy runs on SIGTERM', () => {
    const main = readFileSync(
      path.join(__dirname, '..', '..', 'main.ts'),
      'utf8',
    );
    const hooks = main.indexOf('app.enableShutdownHooks()');
    const listen = main.indexOf('app.listen(');
    expect(hooks).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(hooks);
  });

  it('onModuleDestroy hands the RENDERING rows it holds back, fenced by print_locked_at (attempt not counted)', async () => {
    const b = build();
    let release!: () => void;
    b.render.renderPrint.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({
            files,
            proof_key: null,
            report: { fitted: {}, missing: [], elements: 1 },
          });
      }) as never,
    );
    const job = b.queue.process(row(), () => NOW);
    await new Promise((r) => setImmediate(r));
    await b.queue.onModuleDestroy();
    const first = (
      b.prisma.orderItemDesign.updateMany.mock.calls as unknown as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][]
    )[0][0];
    expect(first.where).toEqual({
      id: 'oid1',
      print_status: DesignPrintStatus.RENDERING,
      print_locked_at: LOCK,
    });
    expect(first.data).toEqual({
      print_status: DesignPrintStatus.PENDING,
      print_locked_at: null,
      print_attempts: { decrement: 1 },
    });
    // The late result misses its fence: its files are dropped.
    b.prisma.orderItemDesign.updateMany.mockResolvedValueOnce({ count: 0 });
    release();
    await job;
    expect(b.storage.delete).toHaveBeenCalledWith('designer/k.png');
    expect(await b.queue.releaseInflight()).toBe(0);
  });

  it('markPaymentFailed: rows terminal, designs no other live order uses released', async () => {
    const b = build();
    b.prisma.orderItemDesign.findMany
      .mockResolvedValueOnce([
        { design_id: 'd1' },
        { design_id: 'd2' },
      ] as never)
      .mockResolvedValueOnce([{ design_id: 'd2' }] as never);
    const res = await b.queue.markPaymentFailed('o1', NOW);
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenCalledWith({
      where: { order_id: 'o1', terminal_at: null },
      data: { terminal_at: NOW },
    });
    expect(b.prisma.design.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['d1'] }, status: 'ORDERED' },
      data: { status: 'IN_CART', updated_at: NOW },
    });
    expect(res.released).toBe(1);
  });

  it('reviveOrder: a late payment makes the rows live and re-freezes the designs', async () => {
    const b = build();
    b.prisma.orderItemDesign.findMany.mockResolvedValueOnce([
      { id: 'oid1', design_id: 'd1' },
    ] as never);
    await expect(b.queue.reviveOrder('o1')).resolves.toBe(1);
    expect(b.prisma.orderItemDesign.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['oid1'] } },
      data: { terminal_at: null },
    });
    expect(b.prisma.design.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['d1'] } },
      data: { status: 'ORDERED' },
    });
  });

  it('backfill: paid / COD rows never requested, app in effect, not terminal', async () => {
    const b = build();
    await b.queue.backfillRequested();
    const sql = sqlOf(b.prisma.$executeRaw);
    expect(sql).toMatch(/d\.print_requested_at IS NULL/);
    expect(sql).toMatch(/d\.terminal_at IS NULL/);
    expect(sql).toMatch(
      /o\.payment_status = 'paid' OR o\.payment_method::text = 'COD'/,
    );
    expect(sql).toMatch(/sa\.available AND sa\.enabled/);
  });
});

describe('print route ?format=', () => {
  it('absent / png → png, pdf → pdf, anything else → 400', () => {
    expect(printFormatParam(undefined)).toBe('png');
    expect(printFormatParam('png')).toBe('png');
    expect(printFormatParam('pdf')).toBe('pdf');
    for (const bad of ['PDF', 'svg', '../x', ['pdf', 'pdf'], { a: 1 }]) {
      expect(() => printFormatParam(bad)).toThrow(BadRequestException);
    }
  });
});
