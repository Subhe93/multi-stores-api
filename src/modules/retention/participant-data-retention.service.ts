import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RetentionService } from './retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from './retention.types';

/**
 * Participant-data retention (headless booking GD1). Two retention tasks
 * that remove personal field values (e.g. a personnummer) the platform no
 * longer needs:
 *
 *  - `kustom.abandoned-sessions`: Kustom checkout sessions that never became
 *    an order (`order_id` null, status not `ordered`) and expired more than
 *    KUSTOM_SESSION_KEEP_AFTER_EXPIRY_MS ago. Their `items` snapshot holds
 *    the shopper's field values. Expired sessions are never read again: the
 *    designer draft purge only looks at unexpired live sessions, and the
 *    create path already purges week-old expired rows opportunistically.
 *  - `cart.personnummer-values`: `custom_fields` of logged-in cart lines
 *    whose cart has been idle for CART_FIELDS_IDLE_MS, only on lines of
 *    products that have a `validation_rules.format = 'personnummer'` field.
 *    Stores without such a field are never touched.
 *
 * Both run inside the hourly retention job (batch `limit`, `deadline`), and
 * report counts only on `dryRun`.
 */

export const KUSTOM_ABANDONED_SESSIONS_RETENTION_KEY =
  'kustom.abandoned-sessions';
export const CART_PERSONNUMMER_RETENTION_KEY = 'cart.personnummer-values';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same horizon as the create-path purge of KustomCheckoutService. */
export const KUSTOM_SESSION_KEEP_AFTER_EXPIRY_MS = 7 * DAY_MS;
/** A cart untouched this long counts as abandoned. */
export const CART_FIELDS_IDLE_MS = 30 * DAY_MS;

const PERSONNUMMER_FORMAT = 'personnummer';

@Injectable()
export class ParticipantDataRetentionService implements OnModuleInit {
  private readonly logger = new Logger(ParticipantDataRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly retention?: RetentionService,
  ) {}

  onModuleInit(): void {
    this.retention?.registerTask({
      key: KUSTOM_ABANDONED_SESSIONS_RETENTION_KEY,
      run: (now, opts) => this.purgeAbandonedKustomSessions(now, opts),
    });
    this.retention?.registerTask({
      key: CART_PERSONNUMMER_RETENTION_KEY,
      run: (now, opts) => this.clearIdleCartPersonnummer(now, opts),
    });
  }

  private abandonedSessionWhere(
    now: Date,
  ): Prisma.KustomCheckoutSessionWhereInput {
    return {
      order_id: null,
      status: { not: 'ordered' },
      expires_at: {
        lt: new Date(now.getTime() - KUSTOM_SESSION_KEEP_AFTER_EXPIRY_MS),
      },
    };
  }

  async purgeAbandonedKustomSessions(
    now: Date,
    opts: RetentionRunOptions,
  ): Promise<RetentionTaskResult> {
    const where = this.abandonedSessionWhere(now);
    if (opts.dryRun) {
      const n = await this.prisma.kustomCheckoutSession.count({ where });
      return { purged: n, skipped: 0, errors: 0 };
    }
    let purged = 0;
    for (;;) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
      const batch = await this.prisma.kustomCheckoutSession.findMany({
        where,
        select: { id: true },
        orderBy: { expires_at: 'asc' },
        take: opts.limit,
      });
      if (batch.length === 0) break;
      // The conditions are repeated so a session ordered meanwhile stays.
      const { count } = await this.prisma.kustomCheckoutSession.deleteMany({
        where: { ...where, id: { in: batch.map((s) => s.id) } },
      });
      purged += count;
      if (count === 0 || batch.length < opts.limit) break;
    }
    if (purged) {
      this.logger.log(`Abandoned Kustom sessions: purged ${purged} rows`);
    }
    return { purged, skipped: 0, errors: 0 };
  }

  /** Products with a personnummer-format field (none on most stores). */
  private async personnummerProductIds(): Promise<string[]> {
    const rows = await this.prisma.productCustomField.findMany({
      where: {
        validation_rules: { path: ['format'], equals: PERSONNUMMER_FORMAT },
      },
      select: { product_id: true },
      distinct: ['product_id'],
    });
    return rows.map((r) => r.product_id);
  }

  async clearIdleCartPersonnummer(
    now: Date,
    opts: RetentionRunOptions,
  ): Promise<RetentionTaskResult> {
    const productIds = await this.personnummerProductIds();
    if (productIds.length === 0) return { purged: 0, skipped: 0, errors: 0 };
    const customProductIds = (
      await this.prisma.customProduct.findMany({
        where: { product_id: { in: productIds } },
        select: { id: true },
      })
    ).map((c) => c.id);
    const where: Prisma.CartItemWhereInput = {
      custom_fields: { not: Prisma.DbNull },
      cart: {
        updated_at: { lt: new Date(now.getTime() - CART_FIELDS_IDLE_MS) },
      },
      OR: [
        { product_id: { in: productIds } },
        ...(customProductIds.length
          ? [{ custom_product_id: { in: customProductIds } }]
          : []),
      ],
    };
    if (opts.dryRun) {
      const n = await this.prisma.cartItem.count({ where });
      return { purged: n, skipped: 0, errors: 0 };
    }
    let purged = 0;
    for (;;) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
      const batch = await this.prisma.cartItem.findMany({
        where,
        select: { id: true },
        take: opts.limit,
      });
      if (batch.length === 0) break;
      // Re-checked in the update: a cart used meanwhile keeps its values.
      const { count } = await this.prisma.cartItem.updateMany({
        where: { ...where, id: { in: batch.map((i) => i.id) } },
        data: { custom_fields: Prisma.DbNull },
      });
      purged += count;
      if (count === 0 || batch.length < opts.limit) break;
    }
    if (purged) {
      this.logger.log(`Idle cart lines: cleared ${purged} personnummer values`);
    }
    return { purged, skipped: 0, errors: 0 };
  }
}
