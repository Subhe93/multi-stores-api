/*
 * Reviews queries against the local dev Postgres (M171): every Prisma query
 * of ReviewsService is executed for real, so the generated SQL, the nested
 * relation filters and the two raw-SQL CHECK constraints are verified against
 * the migrated schema (the unit specs run on an in-memory double).
 *
 * Opt-in: runs only with REVIEWS_DB_IT=1 and a DATABASE_URL on localhost /
 * 127.0.0.1 (never a remote database). It writes NOTHING: the reads use an
 * existing store (or random ids), and the two constraint probes are inserts
 * that the database must refuse.
 */
import { randomUUID } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import {
  PRISMA_GLOBAL_OMIT,
  type PrismaService,
} from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import { eligibleLineQuery } from './review-eligibility';
import { ReviewLinkTokenService } from './review-link-token.service';
import { ReviewsService } from './reviews.service';
import { fakeConfig } from './reviews-fake-db.mockspec';
import { errorOf } from './reviews-harness.mockspec';

const url = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const describeDb =
  process.env.REVIEWS_DB_IT === '1' && isLocal ? describe : describe.skip;

jest.setTimeout(60_000);

describeDb('ReviewsService (local Postgres, read-only)', () => {
  const prisma = new PrismaClient({ omit: PRISMA_GLOBAL_OMIT });
  const config = fakeConfig() as unknown as ConfigService;
  const tokens = new ReviewLinkTokenService(new JwtService({}), config);
  const apps = {
    isEnabled: jest.fn(() => Promise.resolve(true)),
    getSettings: jest.fn(() => Promise.resolve({})),
  };
  const revalidation = { revalidateStoreById: jest.fn() };
  const service = new ReviewsService(
    prisma as unknown as PrismaService,
    apps as unknown as StoreAppsService,
    revalidation as unknown as RevalidationService,
    tokens,
    config,
  );

  let store: { id: string; creator: { user_id: string } } | null = null;

  beforeAll(async () => {
    store = await prisma.store.findFirst({
      select: { id: true, creator: { select: { user_id: true } } },
      orderBy: { created_at: 'asc' },
    });
  });
  afterAll(() => prisma.$disconnect());

  it('the table and its two CHECK constraints exist', async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"ProductReview"'::regclass AND contype = 'c'
      ORDER BY conname`;
    expect(rows.map((r) => r.conname)).toEqual([
      'ProductReview_rating_chk',
      'ProductReview_target_chk',
    ]);
  });

  it.each([
    ['rating 0', { rating: 0, product: true, custom: false }],
    ['rating 6', { rating: 6, product: true, custom: false }],
    ['no target', { rating: 5, product: false, custom: false }],
    ['both targets', { rating: 5, product: true, custom: true }],
  ])('the database refuses a row with %s', async (_label, row) => {
    // CHECK constraints are evaluated before the foreign keys, so the
    // random ids never matter and no row can be created.
    const insert = prisma.$executeRaw`
      INSERT INTO "ProductReview"
        ("id", "store_id", "product_id", "custom_product_id", "customer_id",
         "rating", "body", "display_name", "locale", "updated_at")
      VALUES
        (${randomUUID()}, ${randomUUID()},
         ${row.product ? randomUUID() : null},
         ${row.custom ? randomUUID() : null},
         ${randomUUID()}, ${row.rating}, 'probe', 'Probe', 'en', now())`;
    await expect(insert).rejects.toThrow(/ProductReview_(rating|target)_chk/);
  });

  it('public read: the slug resolver and the 404 run on the real schema', async () => {
    if (!store) return;
    expect(
      await errorOf(
        service.publicList(store.id, `no-such-product-${randomUUID()}`, 1),
      ),
    ).toEqual({ status: 404, code: 'STOREFRONT_PRODUCT_NOT_FOUND' });
  });

  it('public read: summary + page of a real published product', async () => {
    if (!store) return;
    const scope = await prisma.store.findUnique({
      where: { id: store.id },
      select: { creator_id: true },
    });
    const translation = await prisma.productTranslation.findFirst({
      where: {
        product: { creator_id: scope!.creator_id, status: 'PUBLISHED' },
      },
      select: { slug: true },
    });
    if (!translation) return;
    const page = await service.publicList(store.id, translation.slug, 2);
    expect(page.page).toBe(2);
    expect(page.summary.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(page.items)).toBe(true);
  });

  it('owner list, counts and badge (joined select, count, groupBy)', async () => {
    if (!store) return;
    const userId = store.creator.user_id;
    const page = await service.ownerList(userId, {
      status: 'PENDING',
      rating: '5',
      product_id: randomUUID(),
    });
    expect(page).toMatchObject({ items: [], total: 0, page: 1, limit: 25 });
    const all = await service.ownerList(userId, {});
    expect(all.total).toBeGreaterThanOrEqual(0);
    expect((await service.pendingCount(userId)).count).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('owner actions on an unknown review / order: 404 from the scoped queries', async () => {
    if (!store) return;
    const userId = store.creator.user_id;
    expect(
      await errorOf(
        service.setStatus(
          userId,
          randomUUID(),
          'APPROVED',
          new Date().toISOString(),
        ),
      ),
    ).toEqual({ status: 404, code: 'REVIEW_NOT_FOUND' });
    expect(await errorOf(service.ownerDelete(userId, randomUUID()))).toEqual({
      status: 404,
      code: 'REVIEW_NOT_FOUND',
    });
    expect(await errorOf(service.createLinks(userId, randomUUID()))).toEqual({
      status: 404,
      code: 'ORDER_NOT_FOUND',
    });
  });

  it('eligible-line lookup and the review link lookup (nested relation filters)', async () => {
    if (!store) return;
    const order = await prisma.order.findFirst(
      eligibleLineQuery(store.id, randomUUID(), {
        kind: 'custom_product',
        id: randomUUID(),
      }),
    );
    expect(order).toBeNull();
    const { token } = await tokens.sign({
      userId: randomUUID(),
      storeId: store.id,
      orderId: randomUUID(),
      orderItemId: randomUUID(),
    });
    expect(await errorOf(service.linkContext(store.id, token))).toEqual({
      status: 401,
      code: 'REVIEW_LINK_INVALID',
    });
  });

  it('hooks on ids without reviews are no-ops', async () => {
    expect(await service.hideForOrders([randomUUID()])).toEqual({ hidden: 0 });
    expect(await service.removeForCustomer(randomUUID())).toEqual({
      deleted: 0,
    });
  });
});
