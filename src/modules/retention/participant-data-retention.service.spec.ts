import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  CART_FIELDS_IDLE_MS,
  CART_PERSONNUMMER_RETENTION_KEY,
  KUSTOM_ABANDONED_SESSIONS_RETENTION_KEY,
  KUSTOM_SESSION_KEEP_AFTER_EXPIRY_MS,
  ParticipantDataRetentionService,
} from './participant-data-retention.service';
import type { RetentionService } from './retention.service';
import type { RetentionTask } from './retention.types';

// Headless booking GD1: abandoned Kustom sessions (never ordered, expired a
// week ago) are deleted; idle carts lose the values of personnummer-format
// fields. Ordered / recent sessions, active carts and stores without such a
// field are never touched.

const NOW = new Date('2026-12-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

type Session = {
  id: string;
  order_id: string | null;
  status: string;
  expires_at: Date;
};
type Line = {
  id: string;
  product_id: string | null;
  custom_product_id: string | null;
  custom_fields: unknown;
  cart_updated_at: Date;
};

function lt(v: Date, where?: { lt: Date }) {
  return !where || v < where.lt;
}

function makePrisma(
  sessions: Session[],
  lines: Line[] = [],
  pnrProducts: string[] = [],
) {
  const sessionMatch = (
    s: Session,
    w: {
      order_id?: null;
      status?: { not: string };
      expires_at?: { lt: Date };
      id?: { in: string[] };
    },
  ) =>
    (w.order_id === undefined || s.order_id === null) &&
    (!w.status || s.status !== w.status.not) &&
    lt(s.expires_at, w.expires_at) &&
    (!w.id || w.id.in.includes(s.id));
  const lineMatch = (
    l: Line,
    w: {
      cart?: { updated_at: { lt: Date } };
      OR?: (
        | { product_id: { in: string[] } }
        | { custom_product_id: { in: string[] } }
      )[];
      id?: { in: string[] };
    },
  ) =>
    l.custom_fields !== null &&
    lt(l.cart_updated_at, w.cart?.updated_at) &&
    (!w.OR ||
      w.OR.some((o) =>
        'product_id' in o
          ? o.product_id.in.includes(l.product_id ?? '')
          : o.custom_product_id.in.includes(l.custom_product_id ?? ''),
      )) &&
    (!w.id || w.id.in.includes(l.id));
  return {
    sessions,
    lines,
    kustomCheckoutSession: {
      count: jest.fn(({ where }) =>
        Promise.resolve(sessions.filter((s) => sessionMatch(s, where)).length),
      ),
      findMany: jest.fn(({ where, take }) =>
        Promise.resolve(
          sessions
            .filter((s) => sessionMatch(s, where))
            .slice(0, take)
            .map((s) => ({ id: s.id })),
        ),
      ),
      deleteMany: jest.fn(({ where }) => {
        const gone = sessions.filter((s) => sessionMatch(s, where));
        for (const g of gone) sessions.splice(sessions.indexOf(g), 1);
        return Promise.resolve({ count: gone.length });
      }),
    },
    productCustomField: {
      findMany: jest.fn(() =>
        Promise.resolve(pnrProducts.map((product_id) => ({ product_id }))),
      ),
    },
    customProduct: {
      findMany: jest.fn(() => Promise.resolve([])),
    },
    cartItem: {
      count: jest.fn(({ where }) =>
        Promise.resolve(lines.filter((l) => lineMatch(l, where)).length),
      ),
      findMany: jest.fn(({ where, take }) =>
        Promise.resolve(
          lines
            .filter((l) => lineMatch(l, where))
            .slice(0, take)
            .map((l) => ({ id: l.id })),
        ),
      ),
      updateMany: jest.fn(({ where, data }) => {
        const hit = lines.filter((l) => lineMatch(l, where));
        for (const l of hit) {
          l.custom_fields = data.custom_fields === Prisma.DbNull ? null : 'x';
        }
        return Promise.resolve({ count: hit.length });
      }),
    },
  };
}

const build = (prisma: ReturnType<typeof makePrisma>) =>
  new ParticipantDataRetentionService(prisma as unknown as PrismaService);

const opts = { dryRun: false, limit: 500 };

describe('ParticipantDataRetentionService', () => {
  it('registers both tasks with the retention job', () => {
    const tasks: RetentionTask[] = [];
    const registry = {
      registerTask: (t: RetentionTask) => tasks.push(t),
    } as unknown as RetentionService;
    new ParticipantDataRetentionService(
      makePrisma([]) as unknown as PrismaService,
      registry,
    ).onModuleInit();
    expect(tasks.map((t) => t.key).sort()).toEqual(
      [
        CART_PERSONNUMMER_RETENTION_KEY,
        KUSTOM_ABANDONED_SESSIONS_RETENTION_KEY,
      ].sort(),
    );
  });

  describe('abandoned Kustom sessions', () => {
    const old = new Date(
      NOW.getTime() - KUSTOM_SESSION_KEEP_AFTER_EXPIRY_MS - DAY,
    );
    const recent = new Date(NOW.getTime() - DAY);
    const seed = (): Session[] => [
      { id: 'abandoned', order_id: null, status: 'open', expires_at: old },
      { id: 'expired', order_id: null, status: 'expired', expires_at: old },
      { id: 'ordered', order_id: 'o1', status: 'ordered', expires_at: old },
      { id: 'ordering', order_id: 'o2', status: 'open', expires_at: old },
      { id: 'recent', order_id: null, status: 'open', expires_at: recent },
    ];

    it('purges only never-ordered sessions expired over a week ago', async () => {
      const prisma = makePrisma(seed());
      const res = await build(prisma).purgeAbandonedKustomSessions(NOW, opts);
      expect(res).toEqual({ purged: 2, skipped: 0, errors: 0 });
      expect(prisma.sessions.map((s) => s.id).sort()).toEqual(
        ['ordered', 'ordering', 'recent'].sort(),
      );
    });

    it('dry run only counts', async () => {
      const prisma = makePrisma(seed());
      const res = await build(prisma).purgeAbandonedKustomSessions(NOW, {
        ...opts,
        dryRun: true,
      });
      expect(res.purged).toBe(2);
      expect(prisma.kustomCheckoutSession.deleteMany).not.toHaveBeenCalled();
      expect(prisma.sessions).toHaveLength(5);
    });

    it('works in batches of `limit`', async () => {
      const many: Session[] = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        order_id: null,
        status: 'open',
        expires_at: old,
      }));
      const prisma = makePrisma(many);
      const res = await build(prisma).purgeAbandonedKustomSessions(NOW, {
        ...opts,
        limit: 2,
      });
      expect(res.purged).toBe(5);
      expect(prisma.kustomCheckoutSession.deleteMany).toHaveBeenCalledTimes(3);
    });

    it('stops at the deadline', async () => {
      const prisma = makePrisma(seed());
      const res = await build(prisma).purgeAbandonedKustomSessions(NOW, {
        ...opts,
        deadline: Date.now() - 1,
      });
      expect(res.purged).toBe(0);
      expect(prisma.kustomCheckoutSession.findMany).not.toHaveBeenCalled();
    });
  });

  describe('idle cart personnummer values', () => {
    const idle = new Date(NOW.getTime() - CART_FIELDS_IDLE_MS - DAY);
    const active = new Date(NOW.getTime() - DAY);
    const seed = (): Line[] => [
      {
        id: 'idle-pnr',
        product_id: 'p-course',
        custom_product_id: null,
        custom_fields: { f: '811218-9876' },
        cart_updated_at: idle,
      },
      {
        id: 'active-pnr',
        product_id: 'p-course',
        custom_product_id: null,
        custom_fields: { f: '811218-9876' },
        cart_updated_at: active,
      },
      {
        id: 'idle-other',
        product_id: 'p-tee',
        custom_product_id: null,
        custom_fields: { name: 'ANNA' },
        cart_updated_at: idle,
      },
    ];

    it('no personnummer field anywhere: nothing is read or written', async () => {
      const prisma = makePrisma([], seed(), []);
      const res = await build(prisma).clearIdleCartPersonnummer(NOW, opts);
      expect(res).toEqual({ purged: 0, skipped: 0, errors: 0 });
      expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
      expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
    });

    it('clears only idle lines of products with a personnummer field', async () => {
      const prisma = makePrisma([], seed(), ['p-course']);
      const res = await build(prisma).clearIdleCartPersonnummer(NOW, opts);
      expect(res.purged).toBe(1);
      const byId = Object.fromEntries(
        prisma.lines.map((l) => [l.id, l.custom_fields]),
      );
      expect(byId).toEqual({
        'idle-pnr': null,
        'active-pnr': { f: '811218-9876' },
        'idle-other': { name: 'ANNA' },
      });
      expect(prisma.productCustomField.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            validation_rules: { path: ['format'], equals: 'personnummer' },
          },
        }),
      );
    });

    it('dry run only counts', async () => {
      const prisma = makePrisma([], seed(), ['p-course']);
      const res = await build(prisma).clearIdleCartPersonnummer(NOW, {
        ...opts,
        dryRun: true,
      });
      expect(res.purged).toBe(1);
      expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
    });
  });
});
