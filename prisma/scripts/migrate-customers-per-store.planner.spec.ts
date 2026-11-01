import {
  blockers,
  buildPlan,
  fingerprint,
  maskEmail,
  parseArgs,
  renderPlan,
  type Options,
  type Snapshot,
} from './migrate-customers-per-store.planner';
import {
  CUSTOMERS,
  STORES,
  createdDate,
  orderDate,
  type FxCustomer,
} from './migrate-customers-per-store.fixture-spec';

const storeId = (slug: string) => `store-${slug}`;

/** Builds the in-memory snapshot the loader would read for the fixture. */
function snapshotOf(customers: FxCustomer[] = CUSTOMERS): Snapshot {
  const s: Snapshot = {
    has_store_id_column: true,
    stores: STORES.map((slug) => ({ id: storeId(slug), slug })),
    customers: [],
    orders: [],
    addresses: [],
    carts: [],
    kustom_sessions: [],
    designs: [],
    tax_exemptions: [],
    promotion_usages: [],
    notifications: [],
    invoices: [],
    sessions: [],
    login_tokens: [],
    email_hints: [],
    staff_anomalies: [],
  };
  for (const c of customers) {
    const uid = `u-${c.key}`;
    const cid = `c-${c.key}`;
    s.customers.push({
      user_id: uid,
      customer_id: cid,
      email: c.email,
      status: 'ACTIVE',
      store_id: null,
      created_at: createdDate(c.createdDay),
    });
    for (const a of c.addresses)
      s.addresses.push({ id: `addr-${a}`, customer_id: cid });
    c.orders.forEach((o, i) => {
      const oid = `o-${c.key}-${i}`;
      s.orders.push({
        id: oid,
        order_number: `N-${c.key}-${i}`,
        customer_id: cid,
        store_id: o.store ? storeId(o.store) : null,
        item_store_ids: o.store ? [] : [storeId(o.itemStore)],
        address_id: `addr-${o.address}`,
        created_at: orderDate(o.day),
      });
      if (o.notify)
        s.notifications.push({ id: `n-${oid}`, user_id: uid, order_id: oid });
      if (o.promo)
        s.promotion_usages.push({
          id: `p-${oid}`,
          user_id: uid,
          order_id: oid,
        });
      if (o.invoice) s.invoices.push({ id: `i-${oid}`, order_id: oid });
      if (o.kustom) {
        s.kustom_sessions.push({
          id: `k-${oid}`,
          customer_id: cid,
          store_id: storeId(o.store!),
          order_id: oid,
        });
      }
    });
    if (c.cart) {
      s.carts.push({
        id: `cart-${c.key}`,
        customer_id: cid,
        item_count: 1,
        item_store_ids: [storeId(c.cart)],
      });
    }
    (c.kustom ?? []).forEach((st, i) =>
      s.kustom_sessions.push({
        id: `k-${c.key}-${i}`,
        customer_id: cid,
        store_id: storeId(st),
        order_id: null,
      }),
    );
    (c.designs ?? []).forEach((st, i) =>
      s.designs.push({
        id: `d-${c.key}-${i}`,
        customer_id: cid,
        store_id: storeId(st),
      }),
    );
    (c.tax ?? []).forEach((st, i) =>
      s.tax_exemptions.push({
        id: `t-${c.key}-${i}`,
        customer_id: cid,
        store_id: storeId(st),
        active: true,
      }),
    );
    if (c.resetSession)
      s.sessions.push({
        id: `s-reset-${c.key}`,
        user_id: uid,
        revocation_marker: false,
      });
    if (c.markerSession)
      s.sessions.push({
        id: `s-marker-${c.key}`,
        user_id: uid,
        revocation_marker: true,
      });
    if (c.loginToken) {
      s.login_tokens.push({
        id: `lt-${c.key}`,
        user_id: uid,
        used: false,
        store_id: storeId(c.loginToken),
      });
    }
  }
  return s;
}

const dry = (extra: string[] = []): Options => parseArgs(extra);
/**
 * Adds an account created at (store, email) after migration step (a): a
 * CUSTOMER that already has store_id, with optional orders and a cart.
 */
function addExisting(
  s: Snapshot,
  key: string,
  email: string,
  slug: string,
  extra: { orders?: number; cart?: boolean; taxActive?: boolean } = {},
) {
  const uid = `u-${key}`;
  const cid = `c-${key}`;
  s.customers.push({
    user_id: uid,
    customer_id: cid,
    email,
    status: 'ACTIVE',
    store_id: storeId(slug),
    created_at: new Date('2026-11-01T12:00:00Z'),
  });
  for (let i = 0; i < (extra.orders ?? 0); i++) {
    s.orders.push({
      id: `o-${key}-${i}`,
      order_number: `N-${key}-${i}`,
      customer_id: cid,
      store_id: storeId(slug),
      item_store_ids: [],
      address_id: `addr-${key}`,
      created_at: new Date('2026-11-01T12:30:00Z'),
    });
  }
  if (extra.cart) {
    s.carts.push({
      id: `cart-${key}`,
      customer_id: cid,
      item_count: 1,
      item_store_ids: [storeId(slug)],
    });
  }
  if (extra.taxActive) {
    s.tax_exemptions.push({
      id: `t-${key}`,
      customer_id: cid,
      store_id: storeId(slug),
      active: true,
    });
  }
}

const byKey = (plan: ReturnType<typeof buildPlan>, key: string) =>
  plan.customers.find((c) => c.user_id === `u-${key}`)!;

describe('migrate-customers-per-store planner', () => {
  it('classifies the prod shapes', () => {
    const plan = buildPlan(snapshotOf(), dry());
    expect(plan.totals).toMatchObject({
      customers: 17,
      assign: 12, // 10 single + NULL-store + cart
      split: 2,
      unassigned: 3,
      delete: 0,
      clones: 2,
      orders_moved: 2,
      addresses_cloned: 2,
      addresses_moved: 0,
    });
    for (let i = 1; i <= 10; i++)
      expect(byKey(plan, `s${i}`).decision).toBe('ASSIGN');
    expect(byKey(plan, 's1').store_slug).toBe('naturalcotton');
    expect(byKey(plan, 's10').store_slug).toBe('demo');
    expect(blockers(plan)).toEqual([
      expect.stringContaining('3 customer(s) UNASSIGNED'),
    ]);
  });

  it('splits naturalcotton 1 + namez-se 3: keeps namez-se, clones naturalcotton', () => {
    const a = byKey(buildPlan(snapshotOf(), dry()), 'multiA');
    expect(a.decision).toBe('SPLIT');
    expect(a.store_slug).toBe('namez-se');
    expect(a.clones).toHaveLength(1);
    expect(a.clones[0]).toMatchObject({
      slug: 'naturalcotton',
      orders: ['o-multiA-0'],
      notifications: ['n-o-multiA-0'],
      addresses_clone: ['addr-mA-1'], // also used by namez-se orders
      addresses_move: [],
      cart: null,
    });
    expect(a.revoke_login_tokens).toEqual([]);
  });

  it('splits namez 5 + namez-se 1 and moves every namez-se row', () => {
    const b = byKey(buildPlan(snapshotOf(), dry()), 'multiB');
    expect(b.decision).toBe('SPLIT');
    expect(b.store_slug).toBe('namez');
    expect(b.clones[0]).toEqual({
      store_id: 'store-namez-se',
      slug: 'namez-se',
      into_user_id: null,
      into_customer_id: null,
      cart_into: null,
      orders: ['o-multiB-5'],
      kustom_sessions: ['k-o-multiB-5'],
      designs: ['d-multiB-0'],
      tax_exemptions: ['t-multiB-0'],
      promotion_usages: ['p-o-multiB-5'], // the namez one (o-multiB-4) stays
      notifications: ['n-o-multiB-5'],
      invoices: ['i-o-multiB-5'],
      cart: null,
      addresses_clone: ['addr-mB-1'],
      addresses_move: [],
    });
    // Reset token revoked, logout marker kept; unused login token revoked.
    expect(b.revoke_sessions).toEqual(['s-reset-multiB']);
    expect(b.revoke_login_tokens).toEqual(['lt-multiB']);
  });

  it('places NULL-store orders through their items', () => {
    const n = byKey(buildPlan(snapshotOf(), dry()), 'nullOnly');
    expect(n).toMatchObject({
      decision: 'ASSIGN',
      store_slug: 'naturalcotton',
      signal: 'orders+items',
    });
  });

  it('places a zero-order customer by its cart and lists the rest', () => {
    const plan = buildPlan(snapshotOf(), dry());
    expect(byKey(plan, 'z3')).toMatchObject({
      decision: 'ASSIGN',
      signal: 'cart',
      store_slug: 'namez-se',
    });
    for (const k of ['z1', 'z2', 'z4']) {
      expect(byKey(plan, k)).toMatchObject({
        decision: 'UNASSIGNED',
        unassigned_reason: 'no store signal',
      });
    }
    expect(byKey(plan, 'z2').dependents.addresses).toBe(1);
  });

  it('moves (not clones) an address only the moved orders use; tie goes to the oldest order', () => {
    const c: FxCustomer = {
      key: 'tie',
      email: 'tie@example.test',
      createdDay: 1,
      addresses: ['t-1', 't-2'],
      orders: [
        { store: 'namez', itemStore: 'namez', address: 't-1', day: 9 },
        { store: 'demo', itemStore: 'demo', address: 't-2', day: 3 },
      ],
      cart: 'namez',
    };
    const p = byKey(buildPlan(snapshotOf([c]), dry()), 'tie');
    expect(p.store_slug).toBe('demo'); // 1 order each, demo is older
    expect(p.clones[0]).toMatchObject({
      slug: 'namez',
      addresses_move: ['addr-t-1'],
      addresses_clone: [],
      cart: 'cart-tie', // cart items are namez products
    });
  });

  it('--assign places an UNASSIGNED customer and is refused for one with orders', () => {
    const plan = buildPlan(
      snapshotOf(),
      dry([
        '--assign',
        'u-z1=demo',
        '--assign=u-z2=namez',
        '--assign',
        'u-z4=namez-se',
      ]),
    );
    expect(byKey(plan, 'z1')).toMatchObject({
      decision: 'ASSIGN',
      signal: 'assign',
      store_slug: 'demo',
    });
    expect(blockers(plan)).toEqual([]);

    const bad = buildPlan(
      snapshotOf(),
      dry(['--assign', 'u-s1=demo', '--assign', 'u-z1=nope']),
    );
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('u-z1=nope: no store'),
        expect.stringContaining('the order store decides'),
      ]),
    );
  });

  it('--delete-unassigned refuses customers with dependent rows', () => {
    const plan = buildPlan(snapshotOf(), dry(['--delete-unassigned']));
    expect(byKey(plan, 'z1').decision).toBe('DELETE');
    expect(byKey(plan, 'z4').decision).toBe('DELETE');
    expect(byKey(plan, 'z2').decision).toBe('UNASSIGNED');
    expect(blockers(plan).join('\n')).toContain(
      '--delete-unassigned refused for u-z2',
    );

    const ok = buildPlan(
      snapshotOf(),
      dry([
        '--assign',
        'u-z2=namez',
        '--delete-unassigned=u-z1',
        '--delete-unassigned=u-z4',
      ]),
    );
    expect(blockers(ok)).toEqual([]);
    expect(ok.totals.delete).toBe(2);
  });

  it('skips assigned customers, so a second run plans nothing', () => {
    const s = snapshotOf();
    for (const c of s.customers) c.store_id = 'store-namez';
    const plan = buildPlan(s, dry());
    expect(plan.totals.skip_already_assigned).toBe(17);
    expect(plan.customers.every((c) => c.clones.length === 0)).toBe(true);
  });

  it('fingerprint is stable and changes with the data', () => {
    const fp = fingerprint(buildPlan(snapshotOf(), dry()));
    expect(fingerprint(buildPlan(snapshotOf(), dry()))).toBe(fp);
    // A dry run taken before migration step (a) stays valid after it.
    const pre = snapshotOf();
    pre.has_store_id_column = false;
    expect(fingerprint(buildPlan(pre, dry()))).toBe(fp);
    const s = snapshotOf();
    s.orders.push({
      ...s.orders.find((o) => o.id === 'o-multiA-0')!,
      id: 'o-new',
    });
    expect(fingerprint(buildPlan(s, dry()))).not.toBe(fp);
    expect(
      fingerprint(buildPlan(snapshotOf(), dry(['--assign', 'u-z1=demo']))),
    ).not.toBe(fp);
  });

  it('report masks emails and lists UNASSIGNED with full user ids', () => {
    const report = renderPlan(buildPlan(snapshotOf(), dry()), dry());
    expect(report).not.toMatch(/multia@example\.test|cu1@test\.com/);
    expect(report).toContain('mu***@example.test');
    expect(report).toContain('cu***@test.com  user=u-z1');
    expect(report).not.toMatch(/\$2[aby]\$/); // no bcrypt hash
    expect(report).toMatch(/fingerprint: [0-9a-f]{16}/);
  });

  it('parses the CLI', () => {
    expect(parseArgs([])).toMatchObject({ apply: false, fingerprint: null });
    expect(() => parseArgs(['--apply'])).toThrow(/--fingerprint/);
    expect(parseArgs(['--apply', '--fingerprint=ABC'])).toMatchObject({
      apply: true,
      fingerprint: 'abc',
    });
    expect(() => parseArgs(['--assign', 'x'])).toThrow(/<userId>=<storeSlug>/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown/);
    expect(maskEmail('hello@x.se')).toBe('he***@x.se');
    expect(maskEmail('a@x.se')).toBe('a***@x.se');
  });

  it('reports an existing (store, email) account as a BLOCKER', () => {
    const s = snapshotOf();
    addExisting(s, 'new-s1', 's1@example.test', 'naturalcotton', { orders: 1 });
    const plan = buildPlan(s, dry());
    const line = blockers(plan).find((b) => b.includes('email collision'))!;
    expect(line).toContain('email collision in naturalcotton: old u-s1');
    expect(line).toContain('1 order(s), created 2025-06-02');
    expect(line).toContain(
      'vs existing u-new-s1 (1 order(s), created 2026-11-01',
    );
    expect(line).toContain('--merge-into-existing u-s1');
  });

  it('--merge-into-existing on a single-store customer merges everything and deletes the old row', () => {
    const s = snapshotOf();
    addExisting(s, 'new-z3', 'hu3@mailinator.com', 'namez-se', { cart: true });
    addExisting(s, 'new-s3', 's3@example.test', 'naturalcotton');
    const plan = buildPlan(
      s,
      dry(['--merge-into-existing', 'u-z3', '--merge-into-existing=u-s3']),
    );
    expect(plan.errors).toEqual([]);
    const z3 = byKey(plan, 'z3');
    expect(z3).toMatchObject({ decision: 'MERGE', delete_after_merge: true });
    expect(z3.clones[0]).toMatchObject({
      into_user_id: 'u-new-z3',
      into_customer_id: 'c-new-z3',
      cart: 'cart-z3',
      cart_into: 'cart-new-z3', // the existing account already has a cart
    });
    const s3 = byKey(plan, 's3');
    expect(s3.decision).toBe('MERGE');
    expect(s3.clones[0]).toMatchObject({
      into_user_id: 'u-new-s3',
      orders: ['o-s3-0', 'o-s3-1'],
      addresses_move: ['addr-s3-a'],
      notifications: ['n-o-s3-1'],
      cart_into: null,
    });
    expect(plan.totals).toMatchObject({ merge: 2, merged_into_existing: 2 });
    const report = renderPlan(plan, dry());
    expect(report).toContain('merge → namez-se: into existing user=u-new-z3');
    expect(report).toContain('old User + Customer deleted after the merge');
  });

  it('--merge-into-existing on a clone store merges only that store', () => {
    const s = snapshotOf();
    addExisting(s, 'new-b', 'multib@example.test', 'namez-se');
    const b = byKey(
      buildPlan(s, dry(['--merge-into-existing', 'u-multiB'])),
      'multiB',
    );
    expect(b).toMatchObject({
      decision: 'SPLIT',
      store_slug: 'namez',
      delete_after_merge: false,
    });
    expect(b.clones).toHaveLength(1);
    expect(b.clones[0]).toMatchObject({
      slug: 'namez-se',
      into_user_id: 'u-new-b',
      orders: ['o-multiB-5'],
      addresses_clone: ['addr-mB-1'],
    });
  });

  it('a collision on the primary store keeps the next store on the old row', () => {
    const s = snapshotOf();
    addExisting(s, 'new-a', 'multia@example.test', 'namez-se');
    const a = byKey(
      buildPlan(s, dry(['--merge-into-existing', 'u-multiA'])),
      'multiA',
    );
    expect(a).toMatchObject({ decision: 'SPLIT', store_slug: 'naturalcotton' });
    expect(a.clones[0]).toMatchObject({
      slug: 'namez-se',
      into_user_id: 'u-new-a',
      orders: ['o-multiA-1', 'o-multiA-2', 'o-multiA-3'],
      addresses_clone: ['addr-mA-1'],
      addresses_move: ['addr-mA-2'],
    });
  });

  it('refuses a merge without collision and a double active tax exemption', () => {
    const s = snapshotOf();
    addExisting(s, 'new-b', 'multib@example.test', 'namez-se', {
      taxActive: true,
    });
    const plan = buildPlan(
      s,
      dry([
        '--merge-into-existing',
        'u-multiB',
        '--merge-into-existing',
        'u-s2',
      ]),
    );
    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('u-s2: no existing account with that email'),
        expect.stringContaining(
          'both accounts have an active tax exemption in namez-se',
        ),
      ]),
    );
  });

  it('moves a Kustom session to one clone only when its store and order disagree', () => {
    const s = snapshotOf();
    // multiA gets a third store (demo) and a session of the demo store whose
    // order is the naturalcotton one: both clones match it.
    s.orders.push({
      id: 'o-multiA-demo',
      order_number: 'N-multiA-demo',
      customer_id: 'c-multiA',
      store_id: 'store-demo',
      item_store_ids: [],
      address_id: 'addr-mA-1',
      created_at: orderDate(40),
    });
    s.kustom_sessions.push({
      id: 'k-cross',
      customer_id: 'c-multiA',
      store_id: 'store-demo',
      order_id: 'o-multiA-0',
    });
    const a = byKey(buildPlan(s, dry()), 'multiA');
    expect(a.clones.map((k) => k.slug).sort()).toEqual([
      'demo',
      'naturalcotton',
    ]);
    const holders = a.clones.filter((k) =>
      k.kustom_sessions.includes('k-cross'),
    );
    expect(holders).toHaveLength(1);
  });

  it('lists NULL-store orders for backfill and only applies them with the flag', () => {
    const off = buildPlan(snapshotOf(), dry());
    expect(off.backfill.map((b) => [b.order_number, b.slug])).toEqual([
      ['N-nullOnly-0', 'naturalcotton'],
      ['N-nullOnly-1', 'naturalcotton'],
    ]);
    expect(off.totals).toMatchObject({
      orders_backfill_candidates: 2,
      orders_backfilled: 0,
    });
    expect(renderPlan(off, dry())).toContain(
      'off: listed only, pass --backfill-order-store',
    );
    const on = buildPlan(snapshotOf(), dry(['--backfill-order-store']));
    expect(on.totals.orders_backfilled).toBe(2);
    expect(fingerprint(on)).not.toBe(fingerprint(off));
  });
});
