/**
 * Pure planning half of migrate-customers-per-store.ts (no database access):
 * snapshot types, CLI argument parsing, the per-customer store decision, the
 * plan fingerprint and the human-readable report.
 *
 * See plans/customer-per-store/PLAN.md ("Data migration") and
 * plans/customer-per-store/MIGRATION-NOTES.md ("Data script").
 */
import { createHash } from 'crypto';

// ── Snapshot (what the loader reads from the database) ──────────────────────

export interface SnapStore {
  id: string;
  slug: string;
}

export interface SnapCustomer {
  user_id: string;
  /** Customer profile id; null when the CUSTOMER user has no profile. */
  customer_id: string | null;
  email: string;
  status: string;
  /** User.store_id; null = not assigned yet. */
  store_id: string | null;
  created_at: Date;
}

export interface SnapOrder {
  id: string;
  order_number: string;
  customer_id: string;
  store_id: string | null;
  /** Stores derived from the order items (only loaded for NULL-store orders). */
  item_store_ids: string[];
  address_id: string;
  created_at: Date;
}

export interface SnapAddress {
  id: string;
  customer_id: string;
}

export interface SnapCart {
  id: string;
  customer_id: string;
  item_count: number;
  /** Stores of the cart items (product / custom product creator → store). */
  item_store_ids: string[];
}

export interface SnapStoreRow {
  id: string;
  customer_id: string;
  store_id: string;
}

export interface SnapTaxExemption extends SnapStoreRow {
  /** revoked_at IS NULL (partial unique per store + customer). */
  active: boolean;
}

export interface SnapKustomSession extends SnapStoreRow {
  order_id: string | null;
}

export interface SnapUserOrderRow {
  id: string;
  user_id: string;
  order_id: string | null;
}

export interface SnapInvoice {
  id: string;
  order_id: string;
}

export interface SnapSession {
  id: string;
  user_id: string;
  /** Logout revocation marker (expires_at = epoch); never deleted. */
  revocation_marker: boolean;
}

export interface SnapLoginToken {
  id: string;
  user_id: string;
  used: boolean;
  store_id: string | null;
}

export interface SnapEmailHint {
  email_lc: string;
  store_id: string;
  event: string;
}

export interface SnapStaffAnomaly {
  user_id: string;
  role: string;
  has_customer_profile: boolean;
  has_store_id: boolean;
}

export interface Snapshot {
  /** False before migration 20261109120000_user_store_id is applied. */
  has_store_id_column: boolean;
  stores: SnapStore[];
  customers: SnapCustomer[];
  orders: SnapOrder[];
  addresses: SnapAddress[];
  carts: SnapCart[];
  kustom_sessions: SnapKustomSession[];
  designs: SnapStoreRow[];
  tax_exemptions: SnapTaxExemption[];
  promotion_usages: SnapUserOrderRow[];
  notifications: SnapUserOrderRow[];
  invoices: SnapInvoice[];
  sessions: SnapSession[];
  login_tokens: SnapLoginToken[];
  email_hints: SnapEmailHint[];
  staff_anomalies: SnapStaffAnomaly[];
}

// ── CLI options ─────────────────────────────────────────────────────────────

export interface Options {
  apply: boolean;
  fingerprint: string | null;
  /** user id → store slug (from repeatable --assign <userId>=<slug>). */
  assign: Record<string, string>;
  /** 'all' = every UNASSIGNED customer; otherwise the listed user ids. */
  deleteUnassigned: 'all' | string[];
  /**
   * Old user ids (repeatable --merge-into-existing) whose rows of a store may
   * be merged into the account that already exists there with the same email.
   */
  mergeIntoExisting: string[];
  /** --backfill-order-store: set Order.store_id from the items (default off). */
  backfillOrderStore: boolean;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    apply: false,
    fingerprint: null,
    assign: {},
    deleteUnassigned: [],
    mergeIntoExisting: [],
    backfillOrderStore: false,
  };
  let dryRunFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = splitFlag(arg);
    const value = (): string => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      i++;
      return next;
    };
    switch (flag) {
      case '--dry-run':
        dryRunFlag = true;
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--fingerprint':
        opts.fingerprint = value().trim().toLowerCase();
        break;
      case '--assign': {
        const pair = value();
        const eq = pair.indexOf('=');
        if (eq <= 0 || eq === pair.length - 1) {
          throw new Error(
            `--assign expects <userId>=<storeSlug>, got "${pair}"`,
          );
        }
        const userId = pair.slice(0, eq).trim();
        const slug = pair.slice(eq + 1).trim();
        if (opts.assign[userId] && opts.assign[userId] !== slug) {
          throw new Error(`--assign given twice for ${userId}`);
        }
        opts.assign[userId] = slug;
        break;
      }
      case '--delete-unassigned':
        if (inline === null) {
          opts.deleteUnassigned = 'all';
        } else if (opts.deleteUnassigned !== 'all') {
          opts.deleteUnassigned.push(inline.trim());
        }
        break;
      case '--merge-into-existing': {
        const userId = value().trim();
        if (!opts.mergeIntoExisting.includes(userId)) {
          opts.mergeIntoExisting.push(userId);
        }
        break;
      }
      case '--backfill-order-store':
        opts.backfillOrderStore = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (dryRunFlag && opts.apply) {
    throw new Error('Use either --dry-run or --apply, not both');
  }
  if (opts.apply && !opts.fingerprint) {
    throw new Error(
      '--apply requires --fingerprint=<hash printed by the dry run>',
    );
  }
  return opts;
}

function splitFlag(arg: string): [string, string | null] {
  const eq = arg.indexOf('=');
  if (!arg.startsWith('--') || eq < 0) return [arg, null];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

// ── Plan ────────────────────────────────────────────────────────────────────

// MERGE: every store of the old account collides with an account that
// already exists there; all rows move into those accounts and the old row
// is deleted.
export type Decision =
  | 'SKIP'
  | 'ASSIGN'
  | 'SPLIT'
  | 'MERGE'
  | 'UNASSIGNED'
  | 'DELETE';

export type Signal =
  | 'orders'
  | 'orders+items'
  | 'cart'
  | 'design'
  | 'kustom_session'
  | 'tax_exemption'
  | 'assign';

export interface StoreOrders {
  store_id: string;
  slug: string;
  orders: number;
  first_order_at: string;
}

export interface ClonePlan {
  store_id: string;
  slug: string;
  /**
   * Set when the rows merge into the account that already exists in this
   * store (--merge-into-existing); null = a new User + Customer clone.
   */
  into_user_id: string | null;
  into_customer_id: string | null;
  /** The existing account's cart: the moved cart's items join it. */
  cart_into: string | null;
  orders: string[];
  kustom_sessions: string[];
  designs: string[];
  tax_exemptions: string[];
  promotion_usages: string[];
  notifications: string[];
  /** Informational: invoices follow their order (no customer column). */
  invoices: string[];
  cart: string | null;
  /** Addresses also used by orders that stay: copied, moved orders repointed. */
  addresses_clone: string[];
  /** Addresses used only by this store's moved orders: re-owned. */
  addresses_move: string[];
}

export interface CustomerPlan {
  user_id: string;
  customer_id: string | null;
  email_masked: string;
  decision: Decision;
  signal: Signal | null;
  order_stores: StoreOrders[];
  /** Store the original row is assigned to (ASSIGN / SPLIT). */
  store_id: string | null;
  store_slug: string | null;
  clones: ClonePlan[];
  /** Pending password-reset Session rows to delete (markers are kept). */
  revoke_sessions: string[];
  /** Unused LoginTokens to delete. */
  revoke_login_tokens: string[];
  /** MERGE: the old row is deleted once its rows have moved. */
  delete_after_merge: boolean;
  /** UNASSIGNED / DELETE: why, candidate stores, weak hints, dependents. */
  unassigned_reason: string | null;
  candidates: string[];
  hints: string[];
  dependents: Record<string, number>;
  warnings: string[];
}

export interface BackfillOrder {
  order_id: string;
  order_number: string;
  store_id: string;
  slug: string;
}

export interface Plan {
  has_store_id_column: boolean;
  backfill_enabled: boolean;
  /** NULL-store orders whose items name one store (listed even when off). */
  backfill: BackfillOrder[];
  customers: CustomerPlan[];
  errors: string[];
  warnings: string[];
  totals: Record<string, number>;
}

// Every relation to User / Customer in schema.prisma and how the split treats it.
export const RELATIONS: ReadonlyArray<[string, string]> = [
  [
    'User',
    'original keeps the primary store; one clone per other store (same password_hash, status, avatar, created_at)',
  ],
  [
    'Customer (user_id)',
    'cloned with the User (names, phone, B2B fields, created_at)',
  ],
  [
    'Order.customer_id',
    'moved to the clone of the order store (NULL store: store inferred from items)',
  ],
  [
    'Order.address_id → Address',
    'address used only by moved orders: re-owned; shared with staying orders: cloned + moved orders repointed',
  ],
  ['Address.customer_id (unused by orders)', 'stays on the original account'],
  [
    'Cart.customer_id (+ CartItem)',
    'moved when all its items belong to the clone store',
  ],
  ['KustomCheckoutSession.customer_id', 'moved by session store_id'],
  ['Design.customer_id', 'moved by design store_id'],
  ['StoreCustomerTaxExemption.customer_id', 'moved by exemption store_id'],
  ['PromotionUsage.user_id', 'moved with its order'],
  ['Notification.user_id', "moved with data.order_id's order; otherwise stays"],
  [
    'Order.store_id (NULL)',
    'unchanged unless --backfill-order-store: then set to the single store of its items',
  ],
  [
    'Existing (store, email) account (created after step a)',
    'BLOCKER; --merge-into-existing <oldUserId> moves the old rows of that store into it (its password_hash is kept) and deletes the old row when nothing is left',
  ],
  [
    'Invoice',
    'no customer column (order_id + buyer snapshot): follows its order, unchanged',
  ],
  [
    'Session.user_id',
    'non-marker rows (password-reset tokens) deleted for processed customers; logout markers kept',
  ],
  [
    'LoginToken.user_id',
    'unused tokens deleted for split users and for tokens of another store',
  ],
  [
    'CustomerUpload / OrderCustomFieldValue / OrderItemDesign',
    'no customer column: follow the order',
  ],
  ['EmailLog.recipient', 'email text log, unchanged (used only as a hint)'],
  [
    'OrderTimeline.actor, *_by, actor_id',
    'staff user ids / free text, unchanged',
  ],
];

interface Index {
  storesById: Map<string, SnapStore>;
  storesBySlug: Map<string, SnapStore>;
  ordersByCustomer: Map<string, SnapOrder[]>;
  addressesById: Map<string, SnapAddress>;
  addressesByCustomer: Map<string, SnapAddress[]>;
  cartByCustomer: Map<string, SnapCart>;
  kustomByCustomer: Map<string, SnapKustomSession[]>;
  designsByCustomer: Map<string, SnapStoreRow[]>;
  taxByCustomer: Map<string, SnapTaxExemption[]>;
  promosByUser: Map<string, SnapUserOrderRow[]>;
  notifsByUser: Map<string, SnapUserOrderRow[]>;
  invoicesByOrder: Map<string, SnapInvoice[]>;
  sessionsByUser: Map<string, SnapSession[]>;
  tokensByUser: Map<string, SnapLoginToken[]>;
  hintsByEmail: Map<string, SnapEmailHint[]>;
  /** "<store_id>|<lower(email)>" -> assigned customer account. */
  assignedByStoreEmail: Map<string, SnapCustomer>;
}

function group<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function buildIndex(s: Snapshot): Index {
  return {
    storesById: new Map(s.stores.map((x) => [x.id, x])),
    storesBySlug: new Map(s.stores.map((x) => [x.slug, x])),
    ordersByCustomer: group(s.orders, (r) => r.customer_id),
    addressesById: new Map(s.addresses.map((x) => [x.id, x])),
    addressesByCustomer: group(s.addresses, (r) => r.customer_id),
    cartByCustomer: new Map(s.carts.map((x) => [x.customer_id, x])),
    kustomByCustomer: group(s.kustom_sessions, (r) => r.customer_id),
    designsByCustomer: group(s.designs, (r) => r.customer_id),
    taxByCustomer: group(s.tax_exemptions, (r) => r.customer_id),
    promosByUser: group(s.promotion_usages, (r) => r.user_id),
    notifsByUser: group(s.notifications, (r) => r.user_id),
    invoicesByOrder: group(s.invoices, (r) => r.order_id),
    sessionsByUser: group(s.sessions, (r) => r.user_id),
    tokensByUser: group(s.login_tokens, (r) => r.user_id),
    hintsByEmail: group(s.email_hints, (r) => r.email_lc),
    assignedByStoreEmail: new Map(
      s.customers
        .filter((c) => c.store_id)
        .map((c) => [`${c.store_id}|${c.email.toLowerCase()}`, c]),
    ),
  };
}

/** "ab***@example.com": two characters of the local part plus the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return `${email.slice(0, 2)}***`;
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

const ids = <T extends { id: string }>(rows: T[] | undefined): string[] =>
  (rows ?? []).map((r) => r.id).sort();

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

/** Effective store of an order: its store_id, else the single item store. */
function effectiveStore(o: SnapOrder): string | null {
  if (o.store_id) return o.store_id;
  const stores = uniq(o.item_store_ids);
  return stores.length === 1 ? stores[0] : null;
}

export function buildPlan(s: Snapshot, opts: Options): Plan {
  const ix = buildIndex(s);
  const errors: string[] = [];
  const warnings: string[] = [];
  const slugOf = (id: string | null) =>
    id ? (ix.storesById.get(id)?.slug ?? `?${id.slice(0, 8)}`) : '-';

  if (!s.has_store_id_column) {
    warnings.push(
      'User.store_id does not exist yet (migration 20261109120000_user_store_id not applied): dry run only, --apply will refuse.',
    );
  }
  for (const a of s.staff_anomalies) {
    if (a.has_store_id) {
      errors.push(
        `Staff user ${a.user_id} (${a.role}) has a store_id: User_customer_store_chk would fail; fix by hand.`,
      );
    }
    if (a.has_customer_profile) {
      warnings.push(
        `Staff user ${a.user_id.slice(0, 8)} (${a.role}) owns a Customer profile; left platform-wide (not a customer account).`,
      );
    }
  }

  const customerUserIds = new Set(s.customers.map((c) => c.user_id));
  const mergeSet = new Set(opts.mergeIntoExisting);
  for (const userId of mergeSet) {
    if (!customerUserIds.has(userId)) {
      errors.push(
        `--merge-into-existing ${userId}: no CUSTOMER user with that id.`,
      );
    }
  }
  const backfill: BackfillOrder[] = [];
  for (const [userId, slug] of Object.entries(opts.assign)) {
    if (!customerUserIds.has(userId)) {
      errors.push(`--assign ${userId}: no CUSTOMER user with that id.`);
    }
    if (!ix.storesBySlug.has(slug)) {
      errors.push(`--assign ${userId}=${slug}: no store with that slug.`);
    }
  }
  const deleteSet =
    opts.deleteUnassigned === 'all' ? null : new Set(opts.deleteUnassigned);
  if (deleteSet) {
    for (const userId of deleteSet) {
      if (!customerUserIds.has(userId)) {
        errors.push(
          `--delete-unassigned=${userId}: no CUSTOMER user with that id.`,
        );
      }
      if (opts.assign[userId]) {
        errors.push(`${userId} is both --assign'ed and --delete-unassigned.`);
      }
    }
  }

  const customers = [...s.customers]
    .sort(
      (a, b) =>
        a.created_at.getTime() - b.created_at.getTime() ||
        a.user_id.localeCompare(b.user_id),
    )
    .map((c) => planCustomer(c));

  function planCustomer(c: SnapCustomer): CustomerPlan {
    const cid = c.customer_id;
    const orders = cid ? (ix.ordersByCustomer.get(cid) ?? []) : [];
    const p: CustomerPlan = {
      user_id: c.user_id,
      customer_id: cid,
      email_masked: maskEmail(c.email),
      decision: 'UNASSIGNED',
      signal: null,
      order_stores: [],
      store_id: null,
      store_slug: null,
      clones: [],
      revoke_sessions: [],
      revoke_login_tokens: [],
      delete_after_merge: false,
      unassigned_reason: null,
      candidates: [],
      hints: [],
      dependents: {},
      warnings: [],
    };

    // Orders grouped by effective store.
    const byStore = new Map<string, SnapOrder[]>();
    const unplaced: SnapOrder[] = [];
    let usedItems = false;
    for (const o of orders) {
      const eff = effectiveStore(o);
      if (!eff) {
        unplaced.push(o);
        continue;
      }
      if (!o.store_id) usedItems = true;
      const list = byStore.get(eff);
      if (list) list.push(o);
      else byStore.set(eff, [o]);
    }
    p.order_stores = [...byStore.entries()]
      .map(([storeId, list]) => ({
        store_id: storeId,
        slug: slugOf(storeId),
        orders: list.length,
        first_order_at: new Date(
          Math.min(...list.map((o) => o.created_at.getTime())),
        ).toISOString(),
      }))
      .sort(
        (a, b) =>
          b.orders - a.orders ||
          a.first_order_at.localeCompare(b.first_order_at) ||
          a.slug.localeCompare(b.slug),
      );

    // Backfill candidates: a NULL-store order lands in the account of its
    // item store, so that store is also the order's store.
    for (const o of orders) {
      const eff = effectiveStore(o);
      if (o.store_id || !eff) continue;
      if (c.store_id && c.store_id !== eff) {
        p.warnings.push(
          `order ${o.order_number} (no store_id, items of ${slugOf(eff)}) belongs to a ${slugOf(c.store_id)} account: not backfilled`,
        );
        continue;
      }
      backfill.push({
        order_id: o.id,
        order_number: o.order_number,
        store_id: eff,
        slug: slugOf(eff),
      });
    }

    if (c.store_id) {
      p.decision = 'SKIP';
      p.store_id = c.store_id;
      p.store_slug = slugOf(c.store_id);
      for (const st of p.order_stores) {
        if (st.store_id !== c.store_id) {
          p.warnings.push(
            `already assigned to ${p.store_slug} but has ${st.orders} order(s) in ${st.slug}`,
          );
        }
      }
      return p;
    }

    for (const o of unplaced) {
      const n = uniq(o.item_store_ids).length;
      p.warnings.push(
        `order ${o.order_number} has no store_id and ${n === 0 ? 'no item store' : `items from ${n} stores`}: stays on the kept account`,
      );
    }

    const assignSlug = opts.assign[c.user_id] ?? null;
    const assignStore = assignSlug
      ? ix.storesBySlug.get(assignSlug)
      : undefined;

    if (p.order_stores.length > 0) {
      if (
        assignSlug &&
        !(p.order_stores.length === 1 && p.order_stores[0].slug === assignSlug)
      ) {
        errors.push(
          `--assign ${c.user_id}=${assignSlug}: the customer has orders in ${p.order_stores.map((x) => x.slug).join(', ')}; the order store decides.`,
        );
      }
      p.signal = usedItems ? 'orders+items' : 'orders';
      p.store_id = p.order_stores[0].store_id;
      p.store_slug = p.order_stores[0].slug;
      p.decision = p.order_stores.length === 1 ? 'ASSIGN' : 'SPLIT';
    } else {
      const cart = cid ? ix.cartByCustomer.get(cid) : undefined;
      const tiers: [Signal, string[]][] = [
        ['cart', cart && cart.item_count > 0 ? uniq(cart.item_store_ids) : []],
        [
          'design',
          uniq(
            (cid ? ix.designsByCustomer.get(cid) : [])?.map(
              (r) => r.store_id,
            ) ?? [],
          ),
        ],
        [
          'kustom_session',
          uniq(
            (cid ? ix.kustomByCustomer.get(cid) : [])?.map((r) => r.store_id) ??
              [],
          ),
        ],
        [
          'tax_exemption',
          uniq(
            (cid ? ix.taxByCustomer.get(cid) : [])?.map((r) => r.store_id) ??
              [],
          ),
        ],
      ];
      const tier = tiers.find(([, stores]) => stores.length > 0);
      p.candidates = tier ? tier[1].map(slugOf) : [];
      if (assignStore) {
        p.decision = 'ASSIGN';
        p.signal = 'assign';
        p.store_id = assignStore.id;
        p.store_slug = assignStore.slug;
      } else if (tier && tier[1].length === 1) {
        p.decision = 'ASSIGN';
        p.signal = tier[0];
        p.store_id = tier[1][0];
        p.store_slug = slugOf(tier[1][0]);
      } else {
        p.decision = 'UNASSIGNED';
        p.unassigned_reason = tier
          ? `ambiguous ${tier[0]} signal (${p.candidates.join(', ')})`
          : 'no store signal';
      }
    }

    if (p.decision === 'UNASSIGNED') {
      const tokenStores = (ix.tokensByUser.get(c.user_id) ?? [])
        .map((t) => t.store_id)
        .filter((x): x is string => !!x);
      const mailHints = (ix.hintsByEmail.get(c.email.toLowerCase()) ?? []).map(
        (h) => `${slugOf(h.store_id)} (email:${h.event})`,
      );
      p.hints = uniq([
        ...tokenStores.map((x) => `${slugOf(x)} (login_token)`),
        ...mailHints,
      ]);
      p.dependents = dependentsOf(c);
      const wantDelete = deleteSet === null || deleteSet.has(c.user_id);
      if (wantDelete) {
        const total = Object.values(p.dependents).reduce((a, b) => a + b, 0);
        if (total > 0) {
          errors.push(
            `--delete-unassigned refused for ${c.user_id} (${p.email_masked}): it has dependent rows (${formatCounts(p.dependents)}). Use --assign instead.`,
          );
        } else {
          p.decision = 'DELETE';
        }
      }
      return p;
    }

    // ASSIGN or SPLIT: one account per store, in priority order.
    const storesOrdered = p.order_stores.length
      ? p.order_stores.map((x) => x.store_id)
      : [p.store_id!];
    const accountStores = new Set<string>(storesOrdered);
    const ownAddresses = new Set(
      (cid ? (ix.addressesByCustomer.get(cid) ?? []) : []).map((a) => a.id),
    );

    // An account created at (store, email) after migration step (a) blocks
    // the assignment / clone into that store (User_store_id_email_key).
    const collided = new Map<string, SnapCustomer>();
    for (const st of storesOrdered) {
      const existing = ix.assignedByStoreEmail.get(
        `${st}|${c.email.toLowerCase()}`,
      );
      if (existing && existing.user_id !== c.user_id) {
        collided.set(st, existing);
      }
    }
    const merging = mergeSet.has(c.user_id);
    if (merging && collided.size === 0) {
      errors.push(
        `--merge-into-existing ${c.user_id}: no existing account with that email in ${storesOrdered.map(slugOf).join(', ')}.`,
      );
    }
    const ordersOf = (customerId: string | null) =>
      customerId ? (ix.ordersByCustomer.get(customerId)?.length ?? 0) : 0;
    for (const [st, existing] of collided) {
      const line = `email collision in ${slugOf(st)}: old ${c.user_id} (${p.email_masked}, ${orders.length} order(s), created ${c.created_at.toISOString()}) vs existing ${existing.user_id} (${ordersOf(existing.customer_id)} order(s), created ${existing.created_at.toISOString()})`;
      if (!merging) {
        errors.push(`${line}: pass --merge-into-existing ${c.user_id}`);
        continue;
      }
      p.warnings.push(`${line}: merged into the existing account`);
      if (!existing.customer_id) {
        errors.push(
          `--merge-into-existing ${c.user_id}: existing account ${existing.user_id} has no Customer profile.`,
        );
      }
    }
    const merges = merging ? collided : new Map<string, SnapCustomer>();

    // The kept store: the first one without a merge. None = full MERGE: every
    // row moves out and the old row is deleted.
    const kept = storesOrdered.find((st) => !merges.has(st)) ?? null;
    const home = kept ?? storesOrdered[0];
    if (kept === null) {
      p.decision = 'MERGE';
      p.delete_after_merge = true;
      p.store_id = null;
      p.store_slug = null;
    } else {
      p.store_id = kept;
      p.store_slug = slugOf(kept);
      p.decision = storesOrdered.length > 1 ? 'SPLIT' : 'ASSIGN';
    }

    const placeOf = new Map<string, string>();
    for (const [storeId, list] of byStore) {
      for (const o of list) placeOf.set(o.id, storeId);
    }
    // Unplaced orders follow the kept account (or the home merge target).
    for (const o of unplaced) placeOf.set(o.id, home);

    const kustomRows = cid ? (ix.kustomByCustomer.get(cid) ?? []) : [];
    const designRows = cid ? (ix.designsByCustomer.get(cid) ?? []) : [];
    const taxRows = cid ? (ix.taxByCustomer.get(cid) ?? []) : [];
    const promoRows = ix.promosByUser.get(c.user_id) ?? [];
    const notifRows = ix.notifsByUser.get(c.user_id) ?? [];
    const cart = cid ? ix.cartByCustomer.get(cid) : undefined;
    const cartStores =
      cart && cart.item_count > 0 ? uniq(cart.item_store_ids) : [];

    const claimedKustom = new Set<string>();
    for (const st of storesOrdered) {
      if (st === kept) continue;
      const existing = merges.get(st) ?? null;
      const moved = orders
        .filter((o) => placeOf.get(o.id) === st)
        .map((o) => o.id)
        .sort();
      const movedSet = new Set(moved);
      const clone: ClonePlan = {
        store_id: st,
        slug: slugOf(st),
        into_user_id: existing?.user_id ?? null,
        into_customer_id: existing?.customer_id ?? null,
        cart_into: null,
        orders: moved,
        // A session is claimed once: one whose store and order point at two
        // different clones would otherwise be moved twice (apply aborts).
        kustom_sessions: ids(
          kustomRows.filter(
            (k) =>
              !claimedKustom.has(k.id) &&
              (k.store_id === st ||
                (k.order_id !== null && movedSet.has(k.order_id))),
          ),
        ),
        designs: ids(designRows.filter((d) => d.store_id === st)),
        tax_exemptions: ids(taxRows.filter((t) => t.store_id === st)),
        promotion_usages: ids(
          promoRows.filter(
            (r) => r.order_id !== null && movedSet.has(r.order_id),
          ),
        ),
        notifications: ids(
          notifRows.filter(
            (r) => r.order_id !== null && movedSet.has(r.order_id),
          ),
        ),
        invoices: ids(
          moved.flatMap((oid) => ix.invoicesByOrder.get(oid) ?? []),
        ),
        cart:
          cart && cartStores.length === 1 && cartStores[0] === st
            ? cart.id
            : null,
        addresses_clone: [],
        addresses_move: [],
      };
      for (const id of clone.kustom_sessions) claimedKustom.add(id);
      const usedAddresses = uniq(
        orders.filter((o) => movedSet.has(o.id)).map((o) => o.address_id),
      );
      for (const addressId of usedAddresses) {
        if (!ownAddresses.has(addressId)) {
          p.warnings.push(
            `address ${addressId.slice(0, 8)} used by a moved order belongs to another customer: reference left as is`,
          );
          continue;
        }
        const usedElsewhere = orders.some(
          (o) => o.address_id === addressId && placeOf.get(o.id) !== st,
        );
        if (usedElsewhere) clone.addresses_clone.push(addressId);
        else clone.addresses_move.push(addressId);
      }
      p.clones.push(clone);
    }

    // Full merge: whatever is left moves to the home store's account.
    if (p.decision === 'MERGE') {
      const target = p.clones.find((k) => k.store_id === home)!;
      const taken = (pick: (k: ClonePlan) => string[]) =>
        new Set(p.clones.flatMap(pick));
      const add = (list: string[], extra: string[]) => {
        list.push(...extra);
        list.sort();
      };
      const movedAddr = taken((k) => k.addresses_move);
      // The home account takes the originals; other stores keep their copies.
      const leftAddr = [...ownAddresses].filter((a) => !movedAddr.has(a));
      target.addresses_clone = target.addresses_clone.filter(
        (a) => !leftAddr.includes(a),
      );
      add(target.addresses_move, leftAddr);
      const movedK = taken((k) => k.kustom_sessions);
      add(
        target.kustom_sessions,
        ids(kustomRows.filter((r) => !movedK.has(r.id))),
      );
      const movedD = taken((k) => k.designs);
      add(target.designs, ids(designRows.filter((r) => !movedD.has(r.id))));
      const movedT = taken((k) => k.tax_exemptions);
      add(target.tax_exemptions, ids(taxRows.filter((r) => !movedT.has(r.id))));
      const movedP = taken((k) => k.promotion_usages);
      add(
        target.promotion_usages,
        ids(promoRows.filter((r) => !movedP.has(r.id))),
      );
      const movedN = taken((k) => k.notifications);
      add(
        target.notifications,
        ids(notifRows.filter((r) => !movedN.has(r.id))),
      );
      if (cart && !p.clones.some((k) => k.cart)) target.cart = cart.id;
    }

    // Merge targets: carts join the existing cart; one active tax exemption
    // per store + customer.
    for (const k of p.clones) {
      if (!k.into_customer_id) continue;
      if (k.cart) {
        k.cart_into = ix.cartByCustomer.get(k.into_customer_id)?.id ?? null;
      }
      const theirs = (ix.taxByCustomer.get(k.into_customer_id) ?? []).filter(
        (t) => t.active,
      );
      for (const id of k.tax_exemptions) {
        const mine = taxRows.find((t) => t.id === id)!;
        if (mine.active && theirs.some((t) => t.store_id === mine.store_id)) {
          errors.push(
            `--merge-into-existing ${c.user_id}: both accounts have an active tax exemption in ${slugOf(mine.store_id)}; revoke one first.`,
          );
        }
      }
    }

    // Store-bound rows of stores that get no account stay on the kept one.
    if (p.decision !== 'MERGE') {
      const stray = (label: string, rows: { store_id: string }[]) => {
        for (const st of uniq(rows.map((r) => r.store_id))) {
          if (!accountStores.has(st)) {
            p.warnings.push(
              `${label} in ${slugOf(st)} (no account there) stays on the ${p.store_slug} account`,
            );
          }
        }
      };
      stray('kustom session(s)', kustomRows);
      stray('design(s)', designRows);
      stray('tax exemption(s)', taxRows);
      if (cartStores.length > 1) {
        p.warnings.push(
          `cart has items of ${cartStores.map(slugOf).join(', ')}: stays on the ${p.store_slug} account`,
        );
      } else if (cartStores.length === 1 && !accountStores.has(cartStores[0])) {
        p.warnings.push(
          `cart items of ${slugOf(cartStores[0])} (no account there) stay on the ${p.store_slug} account`,
        );
      }
    }

    // Revocation: every non-marker Session row (password-reset tokens) of a
    // processed customer; unused LoginTokens of split / merged users, or
    // minted by another store than the one the user ends up in.
    p.revoke_sessions = ids(
      (ix.sessionsByUser.get(c.user_id) ?? []).filter(
        (x) => !x.revocation_marker,
      ),
    );
    p.revoke_login_tokens = ids(
      (ix.tokensByUser.get(c.user_id) ?? []).filter(
        (t) =>
          !t.used &&
          (p.clones.length > 0 ||
            (t.store_id !== null && t.store_id !== p.store_id)),
      ),
    );
    return p;
  }

  function dependentsOf(c: SnapCustomer): Record<string, number> {
    const cid = c.customer_id;
    const cart = cid ? ix.cartByCustomer.get(cid) : undefined;
    const d: Record<string, number> = {
      orders: cid ? (ix.ordersByCustomer.get(cid)?.length ?? 0) : 0,
      addresses: cid ? (ix.addressesByCustomer.get(cid)?.length ?? 0) : 0,
      carts: cart ? 1 : 0,
      cart_items: cart?.item_count ?? 0,
      kustom_sessions: cid ? (ix.kustomByCustomer.get(cid)?.length ?? 0) : 0,
      designs: cid ? (ix.designsByCustomer.get(cid)?.length ?? 0) : 0,
      tax_exemptions: cid ? (ix.taxByCustomer.get(cid)?.length ?? 0) : 0,
      promotion_usages: ix.promosByUser.get(c.user_id)?.length ?? 0,
      notifications: ix.notifsByUser.get(c.user_id)?.length ?? 0,
      sessions: ix.sessionsByUser.get(c.user_id)?.length ?? 0,
      login_tokens: ix.tokensByUser.get(c.user_id)?.length ?? 0,
    };
    return d;
  }

  const count = (d: Decision) =>
    customers.filter((c) => c.decision === d).length;
  const sum = (f: (c: ClonePlan) => number) =>
    customers.reduce((a, c) => a + c.clones.reduce((b, k) => b + f(k), 0), 0);
  const totals: Record<string, number> = {
    customers: customers.length,
    skip_already_assigned: count('SKIP'),
    assign: count('ASSIGN'),
    split: count('SPLIT'),
    merge: count('MERGE'),
    unassigned: count('UNASSIGNED'),
    delete: count('DELETE'),
    clones: sum((k) => (k.into_user_id ? 0 : 1)),
    merged_into_existing: sum((k) => (k.into_user_id ? 1 : 0)),
    orders_moved: sum((k) => k.orders.length),
    addresses_cloned: sum((k) => k.addresses_clone.length),
    addresses_moved: sum((k) => k.addresses_move.length),
    kustom_sessions_moved: sum((k) => k.kustom_sessions.length),
    designs_moved: sum((k) => k.designs.length),
    tax_exemptions_moved: sum((k) => k.tax_exemptions.length),
    promotion_usages_moved: sum((k) => k.promotion_usages.length),
    notifications_moved: sum((k) => k.notifications.length),
    invoices_following_orders: sum((k) => k.invoices.length),
    carts_moved: sum((k) => (k.cart ? 1 : 0)),
    sessions_revoked: customers.reduce(
      (a, c) => a + c.revoke_sessions.length,
      0,
    ),
    orders_backfill_candidates: backfill.length,
    orders_backfilled: opts.backfillOrderStore ? backfill.length : 0,
    login_tokens_revoked: customers.reduce(
      (a, c) => a + c.revoke_login_tokens.length,
      0,
    ),
  };

  backfill.sort((a, b) => a.order_number.localeCompare(b.order_number));
  return {
    has_store_id_column: s.has_store_id_column,
    backfill_enabled: opts.backfillOrderStore,
    backfill,
    customers,
    errors,
    warnings,
    totals,
  };
}

/** Whether --apply may run this plan (no errors, nobody left unassigned). */
export function blockers(plan: Plan): string[] {
  const out = [...plan.errors];
  if (!plan.has_store_id_column) {
    out.push(
      'User.store_id is missing: apply migration 20261109120000_user_store_id first.',
    );
  }
  const left = plan.customers.filter((c) => c.decision === 'UNASSIGNED');
  if (left.length > 0) {
    out.push(
      `${left.length} customer(s) UNASSIGNED: pass --assign <userId>=<storeSlug> (or --delete-unassigned for ones without dependent rows).`,
    );
  }
  return out;
}

/**
 * sha256 over the canonical plan (ids, decisions, rows to touch). The CLI
 * shows the first 16 hex characters; --apply recomputes it inside the
 * transaction and aborts when the data changed since the dry run.
 */
export function fingerprint(plan: Plan): string {
  // has_store_id_column is left out on purpose: a dry run taken before
  // migration step (a) stays valid for the apply after it.
  const canonical = {
    errors: plan.errors,
    backfill: plan.backfill_enabled ? plan.backfill : null,
    customers: plan.customers
      .filter((c) => c.decision !== 'SKIP')
      .map((c) => ({
        user_id: c.user_id,
        customer_id: c.customer_id,
        decision: c.decision,
        store_id: c.store_id,
        clones: c.clones,
        delete_after_merge: c.delete_after_merge,
        revoke_sessions: c.revoke_sessions,
        revoke_login_tokens: c.revoke_login_tokens,
      })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

function formatCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(', ') : 'none';
}

/** Human-readable plan. Never prints password hashes; emails are masked. */
export function renderPlan(plan: Plan, opts: Options): string {
  const L: string[] = [];
  const short = (id: string | null) => (id ? id.slice(0, 8) : '-');
  L.push('=== Customer accounts per store: data migration plan ===');
  L.push(`mode: ${opts.apply ? 'APPLY' : 'DRY RUN (nothing is written)'}`);
  const assigns = Object.entries(opts.assign);
  if (assigns.length) {
    L.push(`--assign: ${assigns.map(([u, s]) => `${u}=${s}`).join(' ')}`);
  }
  if (opts.deleteUnassigned === 'all' || opts.deleteUnassigned.length) {
    L.push(
      `--delete-unassigned: ${opts.deleteUnassigned === 'all' ? 'all' : opts.deleteUnassigned.join(' ')}`,
    );
  }
  if (opts.mergeIntoExisting.length) {
    L.push(`--merge-into-existing: ${opts.mergeIntoExisting.join(' ')}`);
  }
  L.push(`--backfill-order-store: ${opts.backfillOrderStore ? 'ON' : 'off'}`);
  L.push('');
  L.push('Relations to User / Customer and their treatment:');
  for (const [rel, how] of RELATIONS) L.push(`  - ${rel}: ${how}`);
  L.push('');

  const order: Decision[] = [
    'SPLIT',
    'MERGE',
    'ASSIGN',
    'DELETE',
    'UNASSIGNED',
    'SKIP',
  ];
  for (const d of order) {
    const list = plan.customers.filter((c) => c.decision === d);
    if (!list.length) continue;
    L.push(`--- ${d} (${list.length}) ---`);
    for (const c of list) {
      const head = `${c.email_masked}  user=${d === 'UNASSIGNED' || d === 'DELETE' ? c.user_id : short(c.user_id)}  customer=${short(c.customer_id)}`;
      L.push(head);
      if (c.order_stores.length) {
        L.push(
          `    orders: ${c.order_stores.map((s) => `${s.slug} ${s.orders} (first ${s.first_order_at.slice(0, 10)})`).join('; ')}`,
        );
      }
      if (d === 'ASSIGN' || d === 'SPLIT' || d === 'SKIP') {
        L.push(
          `    store: ${c.store_slug}${c.signal ? `  [signal: ${c.signal}]` : ''}${d === 'SPLIT' ? '  (original account kept here)' : ''}`,
        );
      }
      for (const k of c.clones) {
        L.push(
          k.into_user_id
            ? `    merge → ${k.slug}: into existing user=${short(k.into_user_id)} customer=${short(k.into_customer_id)} (its password kept)${k.cart_into ? ', cart items join its cart' : ''}`
            : `    clone → ${k.slug}: new User + Customer`,
        );
        L.push(
          `        move: orders ${k.orders.length}, kustom_sessions ${k.kustom_sessions.length}, designs ${k.designs.length}, tax_exemptions ${k.tax_exemptions.length}, promotion_usages ${k.promotion_usages.length}, notifications ${k.notifications.length}, cart ${k.cart ? 1 : 0}`,
        );
        L.push(
          `        addresses: clone ${k.addresses_clone.length} [${k.addresses_clone.map(short).join(', ')}], move ${k.addresses_move.length} [${k.addresses_move.map(short).join(', ')}]; invoices following orders ${k.invoices.length}`,
        );
      }
      if (c.delete_after_merge) {
        L.push('    → old User + Customer deleted after the merge');
      }
      if (c.revoke_sessions.length || c.revoke_login_tokens.length) {
        L.push(
          `    revoke: sessions ${c.revoke_sessions.length}, login_tokens ${c.revoke_login_tokens.length}`,
        );
      }
      if (d === 'UNASSIGNED' || d === 'DELETE') {
        if (c.unassigned_reason) L.push(`    reason: ${c.unassigned_reason}`);
        if (c.hints.length) L.push(`    hints: ${c.hints.join(', ')}`);
        L.push(`    dependents: ${formatCounts(c.dependents)}`);
        if (d === 'DELETE')
          L.push('    → User + Customer deleted (no dependent rows)');
      }
      for (const w of c.warnings) L.push(`    WARN ${w}`);
    }
    L.push('');
  }

  if (plan.backfill.length) {
    L.push(
      `--- Order.store_id backfill (${plan.backfill_enabled ? 'ON: will be written' : 'off: listed only, pass --backfill-order-store'}) ---`,
    );
    for (const b of plan.backfill) {
      L.push(`  order ${b.order_number} → ${b.slug}`);
    }
    L.push('');
  }

  L.push('--- Totals ---');
  for (const [k, n] of Object.entries(plan.totals)) L.push(`  ${k}: ${n}`);
  L.push('');
  for (const w of plan.warnings) L.push(`WARN ${w}`);
  const blocking = blockers(plan);
  for (const e of blocking) L.push(`BLOCKER ${e}`);
  L.push('');
  L.push(`fingerprint: ${fingerprint(plan)}`);
  return L.join('\n');
}
