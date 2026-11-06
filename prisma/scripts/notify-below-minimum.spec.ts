import { PricingType } from '@prisma/client';
import {
  DEDUPE_KEY,
  NOTIFICATION_TYPE,
  buildEmail,
  chooseLocale,
  collectBelowMinimum,
  parseArgs,
  runNotify,
  type CreatorGroup,
  type NotifyDb,
  type NotifyMail,
  type RunDeps,
} from './notify-below-minimum.lib';

// ── Fixtures ────────────────────────────────────────────────────────────────

const variantProduct = (base: number, adjustments: number[] = []) => ({
  base_price: base,
  provider_id: 'prov-1',
  tax_class_id: null,
  tax_exempt: false,
  variants: adjustments.map((a, i) => ({ id: `v${i}`, price_adjustment: a })),
});

const creator = (id: string, locale: string | null) => ({
  id,
  user_id: `user-${id}`,
  display_name: `Name ${id}`,
  user: { email: `${id}@example.com` },
  store: {
    slug: `store-${id}`,
    language_config: locale ? { primary_locale: locale } : null,
  },
});

function cpRow(
  id: string,
  creatorId: string,
  finalPrice: number,
  base = 15,
  locale: string | null = 'sv',
) {
  return {
    id,
    creator_id: creatorId,
    pricing_type: PricingType.SINGLE,
    final_price: finalPrice,
    margin_amount: null,
    translations: [
      { locale: 'en', title: `EN ${id}` },
      { locale: 'sv', title: `SV ${id}` },
    ],
    selected_variants: [],
    product: variantProduct(base),
    creator: creator(creatorId, locale),
  };
}

/** Unused by the mocked setup loader; the collector only passes it on. */
const taxService = { contextFor: jest.fn(), loadTaxData: jest.fn() };

jest.mock('../../src/modules/custom-products/price-floor', () => {
  const actual = jest.requireActual<
    typeof import('../../src/modules/custom-products/price-floor')
  >('../../src/modules/custom-products/price-floor');
  return {
    ...actual,
    // The real loader needs the tax engine's data tables; the floor math
    // (customProductFloorViolation) stays real.
    loadPriceFloorSetup: jest.fn(() =>
      Promise.resolve({
        pricesIncludeVat: true,
        currency: 'SEK',
        rateBpFor: () => 2500,
      }),
    ),
  };
});

function group(
  id: string,
  products = 2,
  locale: string | null = 'sv',
): CreatorGroup {
  return {
    creatorId: id,
    userId: `user-${id}`,
    email: `${id}@example.com`,
    name: `Name ${id}`,
    storeSlug: `store-${id}`,
    primaryLocale: locale,
    currency: 'SEK',
    products: Array.from({ length: products }, (_, i) => ({
      id: `${id}-cp${i}`,
      title: `Secret title ${id}-${i}`,
      price: 15,
      minimum: 18.75,
    })),
  };
}

interface Row {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  created_at: Date;
  data: { dedupe_key?: string; email_sent?: boolean; locale?: string };
}
interface FindArgs {
  where: { user_id: string; type: string; created_at: { gte: Date } };
}
interface CreateArgs {
  data: Omit<Row, 'id' | 'created_at'>;
}
interface UpdateArgs {
  where: { id: string };
  data: Pick<Row, 'data'>;
}
type MailOpts = Parameters<NotifyMail['send']>[0];

function memoryDb() {
  const rows: Row[] = [];
  const notification = {
    findFirst: jest.fn((args: FindArgs) => {
      const w = args.where;
      const hits = rows
        .filter(
          (r) =>
            r.user_id === w.user_id &&
            r.type === w.type &&
            r.created_at >= w.created_at.gte,
        )
        .sort((x, y) => y.created_at.getTime() - x.created_at.getTime());
      return Promise.resolve(hits[0] ?? null);
    }),
    create: jest.fn((args: CreateArgs) => {
      const row: Row = {
        id: `n${rows.length + 1}`,
        created_at: new Date(),
        ...args.data,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn((args: UpdateArgs) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return Promise.resolve(row);
    }),
  };
  const db = { notification } as unknown as NotifyDb;
  return { db, rows, notification };
}

function deps(db: NotifyDb, sent = true) {
  const lines: string[] = [];
  const send = jest.fn((opts: MailOpts) =>
    Promise.resolve({ sent: sent && !!opts.to }),
  );
  const mail = { send };
  const sleep = jest.fn(() => Promise.resolve());
  const d: RunDeps = {
    db,
    mail,
    dashboardUrl: 'https://dash.example.com/',
    log: (l) => lines.push(l),
    sleep,
  };
  return { d, lines, mail, sleep };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('notify-below-minimum', () => {
  describe('collectBelowMinimum', () => {
    it('groups below-minimum products per creator with the shared floor math', async () => {
      const rows = [
        cpRow('a1', 'A', 15), // 15 < 18.75 -> below
        cpRow('a2', 'A', 18.75), // exactly the minimum -> fine
        cpRow('a3', 'A', 12.49, 9.99), // 12.49 = ceil(9.99 x 1.25) -> fine
        cpRow('a4', 'A', 12.48, 9.99), // one cent short -> below
        cpRow('b1', 'B', 10, 15, 'ar'),
        cpRow('c1', 'C', 30), // nothing below -> creator left out
      ];
      const findMany = jest.fn(
        (args: {
          where: {
            status: string;
            creator: { store: { is: { store_type: string } } };
          };
        }) => Promise.resolve(args && rows),
      );
      const prisma = { customProduct: { findMany } };
      const groups = await collectBelowMinimum(prisma as never, taxService);

      const where = findMany.mock.calls[0][0].where;
      expect(where.status).toBe('PUBLISHED');
      expect(where.creator.store.is.store_type).toBe('MARKETPLACE');

      expect(
        groups.map((g) => [g.creatorId, g.products.map((p) => p.id)]),
      ).toEqual([
        ['A', ['a1', 'a4']],
        ['B', ['b1']],
      ]);
      expect(groups[0].products[0]).toEqual({
        id: 'a1',
        title: 'SV a1',
        price: 15,
        minimum: 18.75,
      });
      expect(groups[0].products[1]).toMatchObject({
        price: 12.48,
        minimum: 12.49,
      });
      // Arabic store without an Arabic title falls back to another title.
      expect(groups[1]).toMatchObject({
        storeSlug: 'store-B',
        primaryLocale: 'ar',
        currency: 'SEK',
      });
      expect(groups[1].products[0].title).toBe('EN b1');
    });
  });

  describe('chooseLocale', () => {
    it('prefers the dashboard locale, then the store locale, then en', () => {
      expect(chooseLocale('de', 'sv')).toBe('de');
      expect(chooseLocale('fr-FR', 'sv')).toBe('fr');
      expect(chooseLocale(null, 'sv')).toBe('sv');
      expect(chooseLocale('xx', 'tr')).toBe('tr');
      expect(chooseLocale(undefined, 'ja')).toBe('en');
      expect(chooseLocale(null, null)).toBe('en');
    });

    it('sends the email and notification in the chosen locale', async () => {
      const db = memoryDb();
      const { d, mail } = deps(db.db);
      await runNotify(
        [group('A', 2, 'sv'), group('B', 3, 'ar'), group('C', 1, null)],
        { send: true, force: false, delayMs: 0 },
        d,
      );
      const subjects = mail.send.mock.calls.map((c) => c[0].subject);
      expect(subjects).toEqual([
        'Åtgärd krävs: produktpriser under minimipriset (2)',
        'مطلوب إجراء: أسعار منتجات أقل من الحد الأدنى (3)',
        'Action needed: product prices below the minimum (1)',
      ]);
      expect(db.rows.map((r) => r.data.locale)).toEqual(['sv', 'ar', 'en']);
      expect(db.rows[0].title).toBe('Åtgärd krävs: produktpriser under minimipriset (2)');
    });
  });

  describe('buildEmail', () => {
    it('lists title, prices and the edit link; Arabic is RTL', () => {
      const g = group('A', 1);
      g.products[0].title = 'Tee <b>';
      const en = buildEmail(g, 'en', 'https://dash.example.com/', 'ShopsDoor');
      expect(en.subject).toBe('Action needed: product prices below the minimum (1)');
      expect(en.html).toContain('Tee &lt;b&gt;');
      expect(en.html).toContain(
        'https://dash.example.com/creator/custom-products/A-cp0',
      );
      expect(en.text).toContain('SEK');
      expect(en.text).toContain('18.75');
      expect(en.html).not.toContain('dir="rtl"');
      const ar = buildEmail(g, 'ar', 'https://dash.example.com');
      expect(ar.html).toContain('dir="rtl"');
    });
  });

  describe('runNotify', () => {
    it('dry run prints counts and ids only, never PII, and writes nothing', async () => {
      const db = memoryDb();
      const { d, lines, mail } = deps(db.db);
      const summary = await runNotify(
        [group('A', 2), group('B', 1)],
        { send: false, force: false, delayMs: 1000 },
        d,
      );
      const out = lines.join('\n');
      expect(out).toContain('2 creators, 3 published custom products');
      expect(out).toContain('creator=A store=store-A products=2');
      expect(out).toContain('creator=B store=store-B products=1');
      expect(out).not.toMatch(/@example\.com|Name A|Secret title|18[.,]75|15/);
      expect(mail.send).not.toHaveBeenCalled();
      expect(db.notification.create).not.toHaveBeenCalled();
      expect(db.notification.update).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ creators: 2, products: 3, sent: 0 });
    });

    it('sends once per creator, rate limited, and skips them on a second run', async () => {
      const db = memoryDb();
      const first = deps(db.db);
      const s1 = await runNotify(
        [group('A'), group('B'), group('C')],
        { send: true, force: false, delayMs: 1000 },
        first.d,
      );
      expect(s1).toMatchObject({ sent: 3, skipped: 0, failed: 0 });
      expect(first.mail.send).toHaveBeenCalledTimes(3);
      expect(first.sleep).toHaveBeenCalledTimes(2);
      expect(first.sleep).toHaveBeenCalledWith(1000);
      expect(db.rows).toHaveLength(3);
      expect(db.rows[0]).toMatchObject({
        type: NOTIFICATION_TYPE,
        user_id: 'user-A',
        data: { dedupe_key: DEDUPE_KEY, email_sent: true },
      });
      expect(first.mail.send.mock.calls[0]).toEqual([
        expect.objectContaining({
          to: 'A@example.com',
          event: 'price_below_minimum',
        }),
      ]);
      // The summary line carries counts only.
      expect(first.lines.join('\n')).not.toMatch(/@example\.com|Secret/);

      const second = deps(db.db);
      const s2 = await runNotify(
        [group('A'), group('B'), group('C')],
        { send: true, force: false, delayMs: 1000 },
        second.d,
      );
      expect(s2).toMatchObject({ sent: 0, skipped: 3 });
      expect(second.mail.send).not.toHaveBeenCalled();
      expect(db.rows).toHaveLength(3);

      const forced = deps(db.db);
      const s3 = await runNotify(
        [group('A')],
        { send: true, force: true, delayMs: 0 },
        forced.d,
      );
      expect(s3).toMatchObject({ sent: 1, skipped: 0 });
      expect(db.rows).toHaveLength(4);
    });

    it('resends after the 30-day window', async () => {
      const db = memoryDb();
      await runNotify(
        [group('A')],
        { send: true, force: false, delayMs: 0 },
        deps(db.db).d,
      );
      db.rows[0].created_at = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      const again = deps(db.db);
      const s = await runNotify(
        [group('A')],
        { send: true, force: false, delayMs: 0 },
        again.d,
      );
      expect(s.sent).toBe(1);
      expect(db.rows).toHaveLength(2);
    });

    it('retries a failed email without a second notification', async () => {
      const db = memoryDb();
      const failing = deps(db.db, false);
      const s1 = await runNotify(
        [group('A')],
        { send: true, force: false, delayMs: 0 },
        failing.d,
      );
      expect(s1).toMatchObject({ sent: 0, failed: 1 });
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0].data.email_sent).toBe(false);

      const ok = deps(db.db);
      const s2 = await runNotify(
        [group('A')],
        { send: true, force: false, delayMs: 0 },
        ok.d,
      );
      expect(s2).toMatchObject({ sent: 1, failed: 0 });
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0].data.email_sent).toBe(true);
    });

    it('catches a per-creator failure and continues', async () => {
      const db = memoryDb();
      const { d, mail, lines } = deps(db.db);
      mail.send
        .mockRejectedValueOnce(new Error('smtp said A@example.com bounced'))
        .mockResolvedValue({ sent: true });
      const s = await runNotify(
        [group('A'), group('B')],
        { send: true, force: false, delayMs: 0 },
        d,
      );
      expect(s).toMatchObject({ sent: 1, failed: 1 });
      expect(lines.join('\n')).not.toContain('@example.com');
    });
  });

  describe('parseArgs', () => {
    it('defaults to a dry run', () => {
      expect(parseArgs([])).toEqual({
        send: false,
        force: false,
        delayMs: 1000,
      });
      expect(parseArgs(['--send', '--force', '--delay-ms=500'])).toEqual({
        send: true,
        force: true,
        delayMs: 500,
      });
      expect(parseArgs(['--send', '--dry-run']).send).toBe(false);
      expect(() => parseArgs(['--sned'])).toThrow('Unknown argument');
    });
  });
});
