/**
 * One-time data migration: every CUSTOMER account belongs to exactly one store
 * (plans/customer-per-store/PLAN.md, "Data migration").
 *
 *   - customer with orders in one store        → User.store_id = that store
 *   - customer with orders in several stores   → the original account keeps the
 *     store with the most orders (tie: oldest order); a User + Customer clone
 *     (same password_hash) is created for each other store and that store's
 *     orders, Kustom sessions, designs, tax exemptions, promotion usages,
 *     notifications and cart move to it; addresses used by moved orders are
 *     re-owned, or cloned when orders of another store use them too
 *   - customer without orders                  → cart / design / Kustom session /
 *     tax exemption store, else UNASSIGNED until --assign <userId>=<storeSlug>
 *   - pending password-reset Session rows of processed customers and unused
 *     LoginTokens of split users are deleted; refresh / access JWTs issued
 *     before the deploy carry no store_id claim and are rejected by the API
 *
 * Modes:
 *   --dry-run (default)  print the plan and its fingerprint; writes nothing
 *   --apply --fingerprint=<hash>
 *                        re-plan inside ONE transaction (tables locked),
 *                        abort if the fingerprint differs, then write
 *   --assign <userId>=<storeSlug>   (repeatable) place an UNASSIGNED customer
 *   --delete-unassigned[=<userId>]  delete UNASSIGNED customers (all, or the
 *                        given ones); refused when the customer has ANY
 *                        dependent row
 *
 * Idempotent: customers whose User.store_id is set are skipped, so a second run
 * plans nothing. The dry run also works before migration
 * 20261109120000_user_store_id (every customer is then unassigned); --apply
 * needs that migration. Password hashes are never read into the script or
 * printed; emails are masked.
 *
 * Run with:  npx ts-node prisma/scripts/migrate-customers-per-store.ts [flags]
 * Runbook:   plans/customer-per-store/MIGRATION-NOTES.md ("Data script")
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  blockers,
  buildPlan,
  fingerprint,
  parseArgs,
  renderPlan,
  type CustomerPlan,
  type Options,
  type Plan,
  type Snapshot,
} from './migrate-customers-per-store.planner';

type Db = PrismaClient | Prisma.TransactionClient;

// Tables whose customer-linked rows the plan reads or moves. Locked in SHARE
// ROW EXCLUSIVE mode during --apply: reads stay possible, writes wait.
const LOCKED_TABLES = [
  'Store',
  'User',
  'Customer',
  'Address',
  'Order',
  'OrderItem',
  'Cart',
  'CartItem',
  'KustomCheckoutSession',
  'Design',
  'StoreCustomerTaxExemption',
  'PromotionUsage',
  'Notification',
  'Session',
  'LoginToken',
];

// ── Loader ──────────────────────────────────────────────────────────────────

async function hasStoreIdColumn(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'User' AND column_name = 'store_id'`;
  return rows[0].n > 0;
}

export async function loadSnapshot(db: Db): Promise<Snapshot> {
  const hasCol = await hasStoreIdColumn(db);
  const storeIdExpr = hasCol ? 'u."store_id"' : 'NULL::text';

  const stores = await db.$queryRaw<Snapshot['stores']>`
    SELECT id, slug FROM "Store" ORDER BY slug`;

  // Only the columns the planner needs: password_hash is never selected.
  const customers = await db.$queryRawUnsafe<Snapshot['customers']>(`
    SELECT u.id AS user_id, c.id AS customer_id, u.email, u.status::text AS status,
           ${storeIdExpr} AS store_id, u.created_at
      FROM "User" u
      LEFT JOIN "Customer" c ON c.user_id = u.id
     WHERE u.role = 'CUSTOMER'
     ORDER BY u.created_at, u.id`);

  const staff_anomalies = await db.$queryRawUnsafe<
    Snapshot['staff_anomalies']
  >(`
    SELECT u.id AS user_id, u.role::text AS role,
           (c.id IS NOT NULL) AS has_customer_profile,
           (${storeIdExpr} IS NOT NULL) AS has_store_id
      FROM "User" u
      LEFT JOIN "Customer" c ON c.user_id = u.id
     WHERE u.role <> 'CUSTOMER'
       AND (c.id IS NOT NULL OR ${storeIdExpr} IS NOT NULL)
     ORDER BY u.id`);

  // Orders of customer accounts. For orders without store_id, the stores of
  // their items: custom product creator, own product creator, or the
  // CREATOR fulfiller → that creator's store.
  const orders = await db.$queryRaw<Snapshot['orders']>`
    SELECT o.id, o.order_number, o.customer_id, o.store_id, o.address_id, o.created_at,
           COALESCE((
             SELECT array_agg(DISTINCT s.id)
               FROM "OrderItem" oi
               LEFT JOIN "CustomProduct" cp ON cp.id = oi.custom_product_id
               LEFT JOIN "Product" p ON p.id = oi.product_id
               JOIN "Store" s ON s.creator_id = COALESCE(
                    cp.creator_id, p.creator_id,
                    CASE WHEN oi.fulfiller_type::text = 'CREATOR' THEN oi.fulfiller_id END)
              WHERE oi.order_id = o.id AND o.store_id IS NULL
           ), ARRAY[]::text[]) AS item_store_ids
      FROM "Order" o
      JOIN "Customer" c ON c.id = o.customer_id
      JOIN "User" u ON u.id = c.user_id AND u.role = 'CUSTOMER'
     ORDER BY o.created_at, o.id`;

  const addresses = await db.$queryRaw<Snapshot['addresses']>`
    SELECT a.id, a.customer_id
      FROM "Address" a
      JOIN "Customer" c ON c.id = a.customer_id
      JOIN "User" u ON u.id = c.user_id AND u.role = 'CUSTOMER'
     ORDER BY a.id`;

  // Cart.store_id is never written by the API; counted as an item store anyway.
  const carts = await db.$queryRaw<Snapshot['carts']>`
    SELECT ca.id, ca.customer_id,
           (SELECT COUNT(*)::int FROM "CartItem" ci WHERE ci.cart_id = ca.id) AS item_count,
           COALESCE((
             SELECT array_agg(DISTINCT x.store_id) FROM (
               SELECT COALESCE(scp.id, sp.id) AS store_id
                 FROM "CartItem" ci
                 LEFT JOIN "CustomProduct" cp ON cp.id = ci.custom_product_id
                 LEFT JOIN "Store" scp ON scp.creator_id = cp.creator_id
                 LEFT JOIN "Product" p ON p.id = ci.product_id
                 LEFT JOIN "Store" sp ON sp.creator_id = p.creator_id
                WHERE ci.cart_id = ca.id
               UNION
               SELECT ca.store_id
             ) x WHERE x.store_id IS NOT NULL
           ), ARRAY[]::text[]) AS item_store_ids
      FROM "Cart" ca
      JOIN "Customer" c ON c.id = ca.customer_id
      JOIN "User" u ON u.id = c.user_id AND u.role = 'CUSTOMER'
     ORDER BY ca.id`;

  const kustom_sessions = await db.$queryRaw<Snapshot['kustom_sessions']>`
    SELECT k.id, k.customer_id, k.store_id, k.order_id
      FROM "KustomCheckoutSession" k
     WHERE k.customer_id IS NOT NULL
     ORDER BY k.id`;

  const designs = await db.$queryRaw<Snapshot['designs']>`
    SELECT d.id, d.customer_id, d.store_id
      FROM "Design" d
     WHERE d.customer_id IS NOT NULL
     ORDER BY d.id`;

  const tax_exemptions = await db.$queryRaw<Snapshot['tax_exemptions']>`
    SELECT t.id, t.customer_id, t.store_id, (t.revoked_at IS NULL) AS active
      FROM "StoreCustomerTaxExemption" t
     ORDER BY t.id`;

  const promotion_usages = await db.$queryRaw<Snapshot['promotion_usages']>`
    SELECT pu.id, pu.user_id, pu.order_id
      FROM "PromotionUsage" pu
      JOIN "User" u ON u.id = pu.user_id AND u.role = 'CUSTOMER'
     ORDER BY pu.id`;

  const notifications = await db.$queryRaw<Snapshot['notifications']>`
    SELECT n.id, n.user_id,
           CASE WHEN jsonb_typeof(n.data) = 'object' THEN n.data->>'order_id' END AS order_id
      FROM "Notification" n
      JOIN "User" u ON u.id = n.user_id AND u.role = 'CUSTOMER'
     ORDER BY n.id`;

  const invoices = await db.$queryRaw<Snapshot['invoices']>`
    SELECT i.id, i.order_id
      FROM "Invoice" i
      JOIN "Order" o ON o.id = i.order_id
      JOIN "Customer" c ON c.id = o.customer_id
      JOIN "User" u ON u.id = c.user_id AND u.role = 'CUSTOMER'
     ORDER BY i.id`;

  // logout() stores surrendered refresh tokens with expires_at = epoch; those
  // markers are kept (deleting them would un-revoke the token).
  const sessions = await db.$queryRaw<Snapshot['sessions']>`
    SELECT s.id, s.user_id, (s.expires_at < TIMESTAMP '1970-01-02') AS revocation_marker
      FROM "Session" s
      JOIN "User" u ON u.id = s.user_id AND u.role = 'CUSTOMER'
     ORDER BY s.id`;

  const login_tokens = await db.$queryRaw<Snapshot['login_tokens']>`
    SELECT t.id, t.user_id, (t.used_at IS NOT NULL) AS used, t.store_id
      FROM "LoginToken" t
      JOIN "User" u ON u.id = t.user_id AND u.role = 'CUSTOMER'
     ORDER BY t.id`;

  // Weak hints for UNASSIGNED customers only (EmailLog keeps ~90 days).
  const email_hints = await db.$queryRaw<Snapshot['email_hints']>`
    SELECT DISTINCT lower(el.recipient) AS email_lc, el.store_id, el.event
      FROM "EmailLog" el
     WHERE el.store_id IS NOT NULL AND el.event IN ('welcome', 'account_created')
     ORDER BY 1, 2, 3`;

  return {
    has_store_id_column: hasCol,
    stores,
    customers,
    orders,
    addresses,
    carts,
    kustom_sessions,
    designs,
    tax_exemptions,
    promotion_usages,
    notifications,
    invoices,
    sessions,
    login_tokens,
    email_hints,
    staff_anomalies,
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function columnsOf(tx: Db, table: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ${table}
     ORDER BY ordinal_position`;
  return rows.map((r) => r.column_name);
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * INSERT INTO table SELECT <same columns> FROM table WHERE id = $source, with
 * some columns overridden by parameters (or SQL expressions). Copies every
 * column, including ones added after this script was written.
 */
async function cloneRow(
  tx: Db,
  table: string,
  columns: string[],
  sourceId: string,
  overrides: Record<string, { param: unknown } | { sql: string }>,
): Promise<void> {
  const params: unknown[] = [sourceId];
  const select = columns.map((col) => {
    const o = overrides[col];
    if (!o) return q(col);
    if ('sql' in o) return o.sql;
    params.push(o.param);
    return `$${params.length}`;
  });
  const n = await tx.$executeRawUnsafe(
    `INSERT INTO ${q(table)} (${columns.map(q).join(', ')})
     SELECT ${select.join(', ')} FROM ${q(table)} WHERE "id" = $1`,
    ...params,
  );
  if (n !== 1)
    throw new Error(`clone of ${table} ${sourceId} inserted ${n} rows`);
}

/** UPDATE … WHERE id = ANY(ids) AND <guard>; the row count must match. */
async function moveRows(
  tx: Db,
  table: string,
  set: string,
  setParam: string,
  rowIds: string[],
  guardColumn: string,
  guardValue: string,
): Promise<void> {
  if (!rowIds.length) return;
  const n = await tx.$executeRawUnsafe(
    `UPDATE ${q(table)} SET ${q(set)} = $1
      WHERE "id" = ANY($2::text[]) AND ${q(guardColumn)} = $3`,
    setParam,
    rowIds,
    guardValue,
  );
  if (n !== rowIds.length) {
    throw new Error(
      `${table}.${set}: expected ${rowIds.length} rows, updated ${n}`,
    );
  }
}

async function assignStore(tx: Db, userId: string, storeId: string) {
  const n = await tx.$executeRaw`
    UPDATE "User" SET "store_id" = ${storeId}, "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${userId} AND "role" = 'CUSTOMER' AND "store_id" IS NULL`;
  if (n !== 1)
    throw new Error(`User ${userId}: store assignment updated ${n} rows`);
}

async function applyCustomer(
  tx: Db,
  c: CustomerPlan,
  cols: Record<'User' | 'Customer' | 'Address', string[]>,
  log: (line: string) => void,
): Promise<void> {
  if (c.decision === 'DELETE') {
    const n = await tx.$executeRaw`
      DELETE FROM "User" WHERE "id" = ${c.user_id} AND "role" = 'CUSTOMER' AND "store_id" IS NULL`;
    if (n !== 1) throw new Error(`User ${c.user_id}: delete removed ${n} rows`);
    log(`deleted ${c.email_masked}`);
    return;
  }
  if (
    c.decision !== 'ASSIGN' &&
    c.decision !== 'SPLIT' &&
    c.decision !== 'MERGE'
  ) {
    return;
  }

  if (c.decision !== 'MERGE') {
    await assignStore(tx, c.user_id, c.store_id!);
    log(`${c.email_masked} → ${c.store_slug}`);
  }

  for (const k of c.clones) {
    let userId: string;
    let customerId: string;
    if (k.into_user_id) {
      // Merge into the account that already exists in this store; its own
      // columns (password_hash included) stay as they are.
      userId = k.into_user_id;
      customerId = k.into_customer_id!;
      const [target] = await tx.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM "User" u JOIN "Customer" c ON c.user_id = u.id
         WHERE u.id = ${userId} AND c.id = ${customerId}
           AND u.role = 'CUSTOMER' AND u.store_id = ${k.store_id}`;
      if (target.n !== 1) {
        throw new Error(`Merge target ${userId} is not the ${k.slug} account`);
      }
    } else {
      userId = randomUUID();
      customerId = randomUUID();
      const now = { sql: 'CURRENT_TIMESTAMP' };
      await cloneRow(tx, 'User', cols.User, c.user_id, {
        id: { param: userId },
        store_id: { param: k.store_id },
        updated_at: now,
      });
      await cloneRow(tx, 'Customer', cols.Customer, c.customer_id!, {
        id: { param: customerId },
        user_id: { param: userId },
        updated_at: now,
      });
    }
    const cid = c.customer_id!;
    await moveRows(
      tx,
      'Address',
      'customer_id',
      customerId,
      k.addresses_move,
      'customer_id',
      cid,
    );
    for (const addressId of k.addresses_clone) {
      const newAddressId = randomUUID();
      await cloneRow(tx, 'Address', cols.Address, addressId, {
        id: { param: newAddressId },
        customer_id: { param: customerId },
      });
      const repointed = await tx.$executeRaw`
        UPDATE "Order" SET "address_id" = ${newAddressId}
         WHERE "id" = ANY(${k.orders}::text[]) AND "address_id" = ${addressId}`;
      if (repointed < 1)
        throw new Error(`Address ${addressId}: no order repointed`);
    }
    await moveRows(
      tx,
      'Order',
      'customer_id',
      customerId,
      k.orders,
      'customer_id',
      cid,
    );
    await moveRows(
      tx,
      'KustomCheckoutSession',
      'customer_id',
      customerId,
      k.kustom_sessions,
      'customer_id',
      cid,
    );
    await moveRows(
      tx,
      'Design',
      'customer_id',
      customerId,
      k.designs,
      'customer_id',
      cid,
    );
    await moveRows(
      tx,
      'StoreCustomerTaxExemption',
      'customer_id',
      customerId,
      k.tax_exemptions,
      'customer_id',
      cid,
    );
    await moveRows(
      tx,
      'PromotionUsage',
      'user_id',
      userId,
      k.promotion_usages,
      'user_id',
      c.user_id,
    );
    await moveRows(
      tx,
      'Notification',
      'user_id',
      userId,
      k.notifications,
      'user_id',
      c.user_id,
    );
    if (k.cart && k.cart_into) {
      // The existing account already has a cart (one per customer): its
      // lines join that cart; the emptied cart goes with the old account.
      await tx.$executeRaw`
        UPDATE "CartItem" SET "cart_id" = ${k.cart_into} WHERE "cart_id" = ${k.cart}`;
    } else if (k.cart) {
      await moveRows(
        tx,
        'Cart',
        'customer_id',
        customerId,
        [k.cart],
        'customer_id',
        cid,
      );
    }
    log(
      `  ${k.into_user_id ? 'merge into' : 'clone'} ${userId.slice(0, 8)} → ${k.slug}: ${k.orders.length} order(s)`,
    );
  }

  if (c.revoke_sessions.length) {
    await tx.$executeRaw`
      DELETE FROM "Session" WHERE "id" = ANY(${c.revoke_sessions}::text[]) AND "user_id" = ${c.user_id}`;
  }
  if (c.revoke_login_tokens.length) {
    await tx.$executeRaw`
      DELETE FROM "LoginToken" WHERE "id" = ANY(${c.revoke_login_tokens}::text[]) AND "user_id" = ${c.user_id}`;
  }

  if (c.delete_after_merge) {
    // Only an empty shell may be deleted: every row with data has moved.
    const [left] = await tx.$queryRaw<{ n: number }[]>`
      SELECT (
        (SELECT COUNT(*) FROM "Order" WHERE customer_id = ${c.customer_id}) +
        (SELECT COUNT(*) FROM "Address" WHERE customer_id = ${c.customer_id}) +
        (SELECT COUNT(*) FROM "CartItem" ci JOIN "Cart" ca ON ca.id = ci.cart_id
          WHERE ca.customer_id = ${c.customer_id}) +
        (SELECT COUNT(*) FROM "KustomCheckoutSession" WHERE customer_id = ${c.customer_id}) +
        (SELECT COUNT(*) FROM "Design" WHERE customer_id = ${c.customer_id}) +
        (SELECT COUNT(*) FROM "StoreCustomerTaxExemption" WHERE customer_id = ${c.customer_id}) +
        (SELECT COUNT(*) FROM "PromotionUsage" WHERE user_id = ${c.user_id}) +
        (SELECT COUNT(*) FROM "Notification" WHERE user_id = ${c.user_id})
      )::int AS n`;
    if (left.n !== 0) {
      throw new Error(`User ${c.user_id}: ${left.n} row(s) left after merge`);
    }
    const n = await tx.$executeRaw`
      DELETE FROM "User" WHERE "id" = ${c.user_id} AND "role" = 'CUSTOMER' AND "store_id" IS NULL`;
    if (n !== 1) throw new Error(`User ${c.user_id}: delete removed ${n} rows`);
    log(`${c.email_masked}: old account merged and deleted`);
  }
}

async function backfillOrders(tx: Db, plan: Plan, log: (l: string) => void) {
  if (!plan.backfill_enabled || !plan.backfill.length) return;
  for (const b of plan.backfill) {
    const n = await tx.$executeRaw`
      UPDATE "Order" SET "store_id" = ${b.store_id}
       WHERE "id" = ${b.order_id} AND "store_id" IS NULL`;
    if (n !== 1)
      throw new Error(`Order ${b.order_number}: backfill updated ${n} rows`);
  }
  log(`backfilled Order.store_id on ${plan.backfill.length} order(s)`);
}

/** Post-conditions checked inside the transaction before COMMIT. */
async function verify(tx: Db): Promise<void> {
  const [r] = await tx.$queryRaw<
    { unassigned: number; staff_with_store: number; foreign_orders: number }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM "User" WHERE role = 'CUSTOMER' AND store_id IS NULL) AS unassigned,
      (SELECT COUNT(*)::int FROM "User" WHERE role <> 'CUSTOMER' AND store_id IS NOT NULL) AS staff_with_store,
      (SELECT COUNT(*)::int FROM "Order" o
         JOIN "Customer" c ON c.id = o.customer_id
         JOIN "User" u ON u.id = c.user_id AND u.role = 'CUSTOMER'
        WHERE o.store_id IS NOT NULL AND o.store_id <> u.store_id) AS foreign_orders`;
  const problems: string[] = [];
  if (r.unassigned)
    problems.push(`${r.unassigned} CUSTOMER row(s) without store_id`);
  if (r.staff_with_store)
    problems.push(`${r.staff_with_store} staff row(s) with store_id`);
  if (r.foreign_orders)
    problems.push(
      `${r.foreign_orders} order(s) whose store differs from the customer's store`,
    );
  if (problems.length) {
    throw new Error(`Post-apply verification failed: ${problems.join('; ')}`);
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

export interface RunResult {
  plan: Plan;
  fingerprint: string;
  applied: boolean;
  report: string;
}

/**
 * Dry run or apply. Throws on a blocker, a fingerprint mismatch or a failed
 * post-condition (the transaction is rolled back).
 */
export async function run(
  prisma: PrismaClient,
  opts: Options,
  log: (line: string) => void = (l) => console.log(l),
): Promise<RunResult> {
  if (!opts.apply) {
    const plan = buildPlan(await loadSnapshot(prisma), opts);
    const report = renderPlan(plan, opts);
    log(report);
    return { plan, fingerprint: fingerprint(plan), applied: false, report };
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `LOCK TABLE ${LOCKED_TABLES.map(q).join(', ')} IN SHARE ROW EXCLUSIVE MODE`,
      );
      const plan = buildPlan(await loadSnapshot(tx), opts);
      const fp = fingerprint(plan);
      const report = renderPlan(plan, opts);
      if (fp !== opts.fingerprint) {
        log(report);
        throw new Error(
          `Fingerprint mismatch: expected ${opts.fingerprint}, the data now gives ${fp}. The data changed since the dry run; review the plan above and rerun.`,
        );
      }
      const blocking = blockers(plan);
      if (blocking.length) {
        log(report);
        throw new Error(`Refusing to apply:\n  ${blocking.join('\n  ')}`);
      }
      log(report);
      log('');
      log('=== Applying ===');
      const cols = {
        User: await columnsOf(tx, 'User'),
        Customer: await columnsOf(tx, 'Customer'),
        Address: await columnsOf(tx, 'Address'),
      };
      for (const c of plan.customers) await applyCustomer(tx, c, cols, log);
      await backfillOrders(tx, plan, log);
      await verify(tx);
      log(`Committed. fingerprint ${fp}`);
      return { plan, fingerprint: fp, applied: true, report };
    },
    { maxWait: 30_000, timeout: 10 * 60_000 },
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    await run(prisma, opts);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
