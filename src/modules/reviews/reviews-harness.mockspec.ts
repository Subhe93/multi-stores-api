/**
 * Shared harness of the reviews specs: a real ReviewsService (and a real
 * ReviewLinkTokenService) over the in-memory Prisma double.
 */
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { TurnstileService } from '../../common/security/turnstile.service';
import type { RequestUser } from '../../common/decorators';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import { ReviewLinkTokenService } from './review-link-token.service';
import { ReviewsService } from './reviews.service';
import {
  FakePrisma,
  IDS,
  fakeConfig,
  fakeStoreApps,
  seedWorld,
} from './reviews-fake-db.mockspec';

export function buildReviews(
  opts: { enabled?: string[]; captcha?: boolean } = {},
) {
  const db = seedWorld();
  const prisma = new FakePrisma(db);
  const apps = fakeStoreApps(db, opts.enabled ?? [IDS.storeA, IDS.storeB]);
  const revalidation = {
    revalidateStoreById: jest.fn((_storeId: string) => Promise.resolve()),
  };
  const config = fakeConfig();
  const jwt = new JwtService({});
  const tokens = new ReviewLinkTokenService(
    jwt,
    config as unknown as ConfigService,
  );
  const turnstile = {
    customersEnabled: opts.captcha ?? false,
    verifyCustomer: jest.fn((_token: unknown, _ip: unknown, _hosts: unknown) =>
      Promise.resolve(),
    ),
  };
  const service = new ReviewsService(
    prisma as unknown as PrismaService,
    apps as unknown as StoreAppsService,
    revalidation as unknown as RevalidationService,
    tokens,
    config as unknown as ConfigService,
    turnstile as unknown as TurnstileService,
  );
  const reviews = () => prisma.db.productReview;
  return {
    db,
    prisma,
    apps,
    revalidation,
    config,
    jwt,
    tokens,
    turnstile,
    service,
    /** Current review rows (the array is replaced by deleteMany). */
    reviews,
    /** A link token of an order line, as the owner would receive it. */
    linkToken: (over: Partial<Parameters<typeof tokens.sign>[0]> = {}) =>
      tokens
        .sign({
          userId: IDS.annaUser,
          storeId: IDS.storeA,
          orderId: IDS.annaOrder,
          orderItemId: IDS.annaOrderLine,
          ...over,
        })
        .then((t) => t.token),
  };
}

export type ReviewsHarness = ReturnType<typeof buildReviews>;

const requestUser = (
  id: string,
  role: RequestUser['role'],
  storeId: string | null,
): RequestUser => ({
  id,
  email: `${id}@example.test`,
  role,
  status: 'ACTIVE',
  storeId,
});

export const USERS = {
  anna: requestUser(IDS.annaUser, 'CUSTOMER', IDS.storeA),
  bertil: requestUser(IDS.bertilUser, 'CUSTOMER', IDS.storeA),
  guest: requestUser(IDS.guestUser, 'CUSTOMER', IDS.storeA),
  cecilia: requestUser(IDS.ceciliaUser, 'CUSTOMER', IDS.storeB),
};

/** The fields of a valid submission (plain object, for HTTP bodies). */
export const submissionFields = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  product_id: IDS.necklace,
  rating: 5,
  title: 'Perfect gift',
  body: 'Fast delivery and the engraving looks great.',
  display_name: 'Anna S.',
  locale: 'sv',
  ...over,
});

/** A valid submission, typed loosely so a spec can pass it as any DTO. */
export const submission = (over: Record<string, unknown> = {}) =>
  submissionFields(over) as never;

/** The coded error of a rejected promise: `{ status, code }`. */
export async function errorOf(
  p: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> {
  try {
    await p;
  } catch (err) {
    const e = err as {
      getStatus?: () => number;
      getResponse?: () => { code?: string };
    };
    if (!e.getStatus || !e.getResponse) throw err;
    return { status: e.getStatus(), code: e.getResponse().code };
  }
  throw new Error('expected the call to be rejected');
}
