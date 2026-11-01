/*
 * migrate-customers-per-store against a real local Postgres.
 *
 * Opt-in: runs only with CUSTOMER_MIGRATION_DB_IT=1 and a DATABASE_URL on
 * localhost / 127.0.0.1 (never a remote database). It never touches that
 * database's data: it creates a throw-away database next to it, applies every
 * migration up to 20261109120000_user_store_id (step a), seeds the prod-shaped
 * fixture (migrate-customers-per-store.fixture-spec.ts), runs the script, then
 * applies 20261109130000_user_store_check (step b) and drops the database.
 *
 *   CUSTOMER_MIGRATION_DB_IT=1 npx jest prisma/scripts/migrate-customers-per-store.db.spec.ts
 */
import { execFileSync } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { cpSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import { run } from './migrate-customers-per-store';
import { parseArgs } from './migrate-customers-per-store.planner';
import {
  CUSTOMERS,
  STORES,
  createdDate,
  orderDate,
} from './migrate-customers-per-store.fixture-spec';

const baseUrl = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(baseUrl);
const describeDb =
  process.env.CUSTOMER_MIGRATION_DB_IT === '1' && isLocal
    ? describe
    : describe.skip;

jest.setTimeout(300_000);

const STEP_B = '20261109130000_user_store_check';
const PRISMA_DIR = resolve(__dirname, '..');
const PRISMA_CLI = resolve(
  PRISMA_DIR,
  '..',
  'node_modules',
  'prisma',
  'build',
  'index.js',
);

const silent = () => undefined;

describeDb('migrate-customers-per-store (local Postgres)', () => {
  const dbName = `ms_custmig_it_${randomBytes(4).toString('hex')}`;
  const url = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const tmp = mkdtempSync(join(tmpdir(), 'custmig-'));
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  let db: PrismaClient;

  const users: Record<string, string> = {};
  const customers: Record<string, string> = {};
  const addresses: Record<string, string> = {};
  const stores: Record<string, string> = {};
  const orders: Record<string, string> = {};

  const deploy = () =>
    execFileSync(
      process.execPath,
      [PRISMA_CLI, 'migrate', 'deploy', '--schema', join(tmp, 'schema.prisma')],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' },
    );

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    cpSync(join(PRISMA_DIR, 'schema.prisma'), join(tmp, 'schema.prisma'));
    cpSync(join(PRISMA_DIR, 'migrations'), join(tmp, 'migrations'), {
      recursive: true,
      filter: (src) => !src.includes(STEP_B),
    });
    deploy();
    db = new PrismaClient({ datasourceUrl: url });
    await seed();
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
    );
    await admin.$disconnect();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seed() {
    const category = await db.category.create({ data: { slug: 'it-cat' } });
    const products: Record<string, string> = {};
    const creators: Record<string, string> = {};
    for (const slug of STORES) {
      const u = await db.user.create({
        data: {
          email: `owner-${slug}@example.test`,
          password_hash: 'x',
          role: 'CREATOR',
          status: 'ACTIVE',
        },
      });
      const creator = await db.creator.create({
        data: { user_id: u.id, display_name: slug },
      });
      creators[slug] = creator.id;
      const store = await db.store.create({
        data: { creator_id: creator.id, slug, name: slug },
      });
      stores[slug] = store.id;
      const p = await db.product.create({
        data: {
          creator_id: creator.id,
          category_id: category.id,
          product_type: 'TRADITIONAL',
          base_price: 10,
        },
      });
      products[slug] = p.id;
    }
    const promo = await db.promotion.create({
      data: {
        type: 'PERCENTAGE',
        level: 'CREATOR_TO_CUSTOMER',
        value: 10,
        starts_at: new Date(),
      },
    });
    const template = await db.designTemplate.create({
      data: { store_id: stores['namez-se'], name: 't' },
    });
    const version = await db.designTemplateVersion.create({
      data: {
        template_id: template.id,
        version: 1,
        spec: {},
        spec_sha256: '0'.repeat(64),
      },
    });

    for (const c of CUSTOMERS) {
      const u = await db.user.create({
        data: {
          email: c.email,
          password_hash: `hash-${c.key}`,
          role: 'CUSTOMER',
          status: 'ACTIVE',
          created_at: createdDate(c.createdDay),
        },
      });
      users[c.key] = u.id;
      const cu = await db.customer.create({
        data: {
          user_id: u.id,
          first_name: c.key,
          last_name: 'L',
          phone: '070',
          company_name: `co-${c.key}`,
        },
      });
      customers[c.key] = cu.id;
      for (const a of c.addresses) {
        const row = await db.address.create({
          data: {
            customer_id: cu.id,
            full_name: a,
            line1: 'x',
            city: 'x',
            postal_code: '1',
            country_code: 'SE',
          },
        });
        addresses[a] = row.id;
      }
      for (const [i, o] of c.orders.entries()) {
        const order = await db.order.create({
          data: {
            order_number: `IT-${c.key}-${i}`,
            customer_id: cu.id,
            address_id: addresses[o.address],
            store_id: o.store ? stores[o.store] : null,
            subtotal: 10,
            total: 10,
            created_at: orderDate(o.day),
            items: {
              create: [
                {
                  product_id: products[o.itemStore],
                  quantity: 1,
                  unit_price: 10,
                  total_price: 10,
                  fulfiller_type: 'CREATOR',
                  fulfiller_id: creators[o.itemStore],
                },
              ],
            },
          },
        });
        orders[`${c.key}-${i}`] = order.id;
        if (o.notify) {
          await db.notification.create({
            data: {
              user_id: u.id,
              type: 'order_paid',
              title: 't',
              body: 'b',
              data: { order_id: order.id },
            },
          });
        }
        if (o.promo) {
          await db.promotionUsage.create({
            data: {
              promotion_id: promo.id,
              order_id: order.id,
              user_id: u.id,
              discount_amount: 1,
            },
          });
        }
        if (o.kustom) {
          await kustom(stores[o.store!], cu.id, order.id);
        }
      }
      if (c.cart) {
        await db.cart.create({
          data: {
            customer_id: cu.id,
            items: { create: [{ product_id: products[c.cart], quantity: 1 }] },
          },
        });
      }
      for (const st of c.kustom ?? []) await kustom(stores[st], cu.id, null);
      for (const st of c.designs ?? []) {
        await db.design.create({
          data: {
            store_id: stores[st],
            product_id: products[st],
            template_version_id: version.id,
            state: {},
            customer_id: cu.id,
            access_token_hash: '0'.repeat(64),
          },
        });
      }
      for (const st of c.tax ?? []) {
        await db.storeCustomerTaxExemption.create({
          data: {
            store_id: stores[st],
            customer_id: cu.id,
            kind: 'FULL',
            created_by: u.id,
          },
        });
      }
      if (c.resetSession) {
        await db.session.create({
          data: {
            user_id: u.id,
            token: `reset-${c.key}`,
            expires_at: new Date(Date.now() + 3_600_000),
          },
        });
      }
      if (c.markerSession) {
        await db.session.create({
          data: {
            user_id: u.id,
            token: `marker-${c.key}`,
            expires_at: new Date(0),
          },
        });
      }
      if (c.loginToken) {
        await db.loginToken.create({
          data: {
            user_id: u.id,
            token_hash: randomBytes(32).toString('hex'),
            store_id: stores[c.loginToken],
            expires_at: new Date(Date.now() + 86_400_000),
          },
        });
      }
    }
  }

  async function kustom(
    storeId: string,
    customerId: string,
    orderId: string | null,
  ) {
    await db.kustomCheckoutSession.create({
      data: {
        store_id: storeId,
        customer_id: customerId,
        order_id: orderId,
        token: randomUUID(),
        callback_token: randomUUID(),
        currency: 'SEK',
        items: [],
        expires_at: new Date(Date.now() + 3_600_000),
      },
    });
  }

  /** Row-level digest of every table the script may write. */
  async function digest(): Promise<string> {
    const rows = await db.$queryRawUnsafe<{ d: string }[]>(`
      SELECT md5(string_agg(t, '|' ORDER BY t)) AS d FROM (
        SELECT 'U' || id || coalesce(store_id, '') || email AS t FROM "User"
        UNION ALL SELECT 'C' || id || user_id FROM "Customer"
        UNION ALL SELECT 'A' || id || customer_id FROM "Address"
        UNION ALL SELECT 'O' || id || customer_id || address_id FROM "Order"
        UNION ALL SELECT 'K' || id || coalesce(customer_id, '') FROM "KustomCheckoutSession"
        UNION ALL SELECT 'D' || id || coalesce(customer_id, '') FROM "Design"
        UNION ALL SELECT 'T' || id || customer_id FROM "StoreCustomerTaxExemption"
        UNION ALL SELECT 'P' || id || user_id FROM "PromotionUsage"
        UNION ALL SELECT 'N' || id || user_id FROM "Notification"
        UNION ALL SELECT 'S' || id || user_id FROM "Session"
        UNION ALL SELECT 'L' || id || user_id FROM "LoginToken"
        UNION ALL SELECT 'R' || id || customer_id FROM "Cart"
      ) x`);
    return rows[0].d;
  }

  // z1 → demo, z2 (has an address) → namez, z4 (no rows at all) deleted.
  const finalArgs = () => [
    '--assign',
    `${users.z1}=demo`,
    '--assign',
    `${users.z2}=namez`,
    `--delete-unassigned=${users.z4}`,
  ];
  const applyArgs = () => [
    ...finalArgs(),
    '--merge-into-existing',
    users.multiB,
    `--merge-into-existing=${users.z3}`,
    '--backfill-order-store',
  ];

  it('dry run plans the prod shapes and writes nothing', async () => {
    const before = await digest();
    const r = await run(db, parseArgs([]), silent);
    // CUSTOMER_MIGRATION_PRINT=1 prints the fixture's dry-run report.
    if (process.env.CUSTOMER_MIGRATION_PRINT === '1') console.log(r.report);
    expect(r.plan.totals).toMatchObject({
      customers: 17,
      assign: 12,
      split: 2,
      unassigned: 3,
      orders_moved: 2,
      addresses_cloned: 2,
      kustom_sessions_moved: 1,
      designs_moved: 1,
      tax_exemptions_moved: 1,
      promotion_usages_moved: 1,
      notifications_moved: 2,
      sessions_revoked: 2,
      login_tokens_revoked: 1,
    });
    expect(r.report).not.toContain('multia@example.test');
    expect(r.report).not.toContain('hash-');
    expect(await digest()).toBe(before);
  });

  it('refuses --delete-unassigned for a customer with dependent rows', async () => {
    const r = await run(db, parseArgs(['--delete-unassigned']), silent);
    expect(r.plan.errors.join('\n')).toContain(
      `--delete-unassigned refused for ${users.z2}`,
    );
    const before = await digest();
    await expect(
      run(
        db,
        parseArgs([
          '--delete-unassigned',
          '--apply',
          `--fingerprint=${r.fingerprint}`,
        ]),
        silent,
      ),
    ).rejects.toThrow(/Refusing to apply/);
    expect(await digest()).toBe(before);
  });

  it('refuses to apply while customers are UNASSIGNED', async () => {
    const r = await run(db, parseArgs([]), silent);
    await expect(
      run(db, parseArgs(['--apply', `--fingerprint=${r.fingerprint}`]), silent),
    ).rejects.toThrow(/UNASSIGNED/);
  });

  it('aborts on a fingerprint mismatch without writing', async () => {
    const before = await digest();
    await expect(
      run(
        db,
        parseArgs([
          ...finalArgs(),
          '--apply',
          '--fingerprint=0000000000000000',
        ]),
        silent,
      ),
    ).rejects.toThrow(/Fingerprint mismatch/);
    // Data changed after the dry run: a new order in a new store.
    const dry = await run(db, parseArgs(finalArgs()), silent);
    const extra = await db.order.create({
      data: {
        order_number: 'IT-late',
        customer_id: customers.s1,
        address_id: addresses['s1-a'],
        store_id: stores.demo,
        subtotal: 1,
        total: 1,
      },
    });
    await expect(
      run(
        db,
        parseArgs([
          ...finalArgs(),
          '--apply',
          `--fingerprint=${dry.fingerprint}`,
        ]),
        silent,
      ),
    ).rejects.toThrow(/Fingerprint mismatch/);
    await db.order.delete({ where: { id: extra.id } });
    expect(await digest()).toBe(before);
  });

  // Accounts created by the new API between step (a) and --apply: a guest
  // checkout on namez-se with the emails of multiB and z3.
  const existing: Record<
    string,
    { user: string; customer: string; cart?: string }
  > = {};
  async function existingAccount(
    key: string,
    email: string,
    withOrder: boolean,
  ) {
    // Raw insert: the store_id must be set at INSERT time (a NULL-store row
    // with this email would hit User_staff_email_key).
    const u = { id: randomUUID() };
    await db.$executeRaw`
      INSERT INTO "User" (id, email, password_hash, role, status, store_id, updated_at)
      VALUES (${u.id}, ${email}, ${`hash-new-${key}`}, 'CUSTOMER', 'ACTIVE', ${stores['namez-se']}, now())`;
    const cu = await db.customer.create({
      data: { user_id: u.id, first_name: `new-${key}`, last_name: 'L' },
    });
    const cart = await db.cart.create({ data: { customer_id: cu.id } });
    existing[key] = { user: u.id, customer: cu.id, cart: cart.id };
    if (withOrder) {
      const a = await db.address.create({
        data: {
          customer_id: cu.id,
          full_name: 'new',
          line1: 'x',
          city: 'x',
          postal_code: '1',
          country_code: 'SE',
        },
      });
      await db.order.create({
        data: {
          order_number: `IT-new-${key}`,
          customer_id: cu.id,
          address_id: a.id,
          store_id: stores['namez-se'],
          subtotal: 1,
          total: 1,
        },
      });
    }
  }

  it('blocks an existing (store, email) account until --merge-into-existing', async () => {
    await existingAccount('multiB', 'multib@example.test', true);
    await existingAccount('z3', 'hu3@mailinator.com', false);
    const r = await run(db, parseArgs(finalArgs()), silent);
    const lines = r.plan.errors.filter((e) => e.includes('email collision'));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain(
      `old ${users.multiB} (mu***@example.test, 6 order(s)`,
    );
    expect(lines.join('\n')).toContain(
      `vs existing ${existing.multiB.user} (1 order(s)`,
    );
    const before = await digest();
    await expect(
      run(
        db,
        parseArgs([
          ...finalArgs(),
          '--apply',
          `--fingerprint=${r.fingerprint}`,
        ]),
        silent,
      ),
    ).rejects.toThrow(/email collision/);
    expect(await digest()).toBe(before);
  });

  it('applies the plan with --assign / --delete-unassigned / --merge-into-existing / --backfill-order-store', async () => {
    const dry = await run(db, parseArgs(applyArgs()), silent);
    expect(dry.plan.errors).toEqual([]);
    const r = await run(
      db,
      parseArgs([
        ...applyArgs(),
        '--apply',
        `--fingerprint=${dry.fingerprint}`,
      ]),
      silent,
    );
    expect(r.applied).toBe(true);

    const all = await db.$queryRaw<
      {
        id: string;
        email: string;
        store_id: string | null;
        password_hash: string;
        created_at: Date;
      }[]
    >`
      SELECT id, email, store_id, password_hash, created_at FROM "User" WHERE role = 'CUSTOMER'`;
    // 17 + 2 accounts created after step (a); z4 deleted, z3 merged and
    // deleted, one clone (multiA); multiB's namez-se rows merged.
    expect(all).toHaveLength(17 + 2 - 1 - 1 + 1);
    expect(all.every((u) => u.store_id)).toBe(true);
    expect(all.find((u) => u.id === users.z4)).toBeUndefined();
    expect(all.find((u) => u.id === users.z1)!.store_id).toBe(stores.demo);
    expect(all.find((u) => u.id === users.z3)).toBeUndefined();
    // z3's cart line joined the existing account's cart.
    expect(
      await db.cartItem.count({ where: { cart_id: existing.z3.cart } }),
    ).toBe(1);
    // Backfill: the NULL-store orders now carry their item store.
    for (const k of ['nullOnly-0', 'nullOnly-1']) {
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: orders[k] } }))
          .store_id,
      ).toBe(stores.naturalcotton);
    }
    expect(all.find((u) => u.id === users.nullOnly)!.store_id).toBe(
      stores.naturalcotton,
    );

    // multiA: original kept for namez-se, clone in naturalcotton.
    const aRows = all.filter((u) => u.email === 'multia@example.test');
    expect(aRows.map((u) => u.store_id).sort()).toEqual(
      [stores['namez-se'], stores.naturalcotton].sort(),
    );
    const aOrig = aRows.find((u) => u.id === users.multiA)!;
    expect(aOrig.store_id).toBe(stores['namez-se']);
    const aClone = aRows.find((u) => u.id !== users.multiA)!;
    expect(aClone.password_hash).toBe('hash-multiA');
    expect(aClone.created_at.getTime()).toBe(aOrig.created_at.getTime());
    const aCloneCustomer = await db.customer.findUniqueOrThrow({
      where: { user_id: aClone.id },
    });
    expect(aCloneCustomer).toMatchObject({
      first_name: 'multiA',
      phone: '070',
      company_name: 'co-multiA',
    });
    const movedA = await db.order.findUniqueOrThrow({
      where: { id: orders['multiA-0'] },
    });
    expect(movedA.customer_id).toBe(aCloneCustomer.id);
    // Shared address cloned: the moved order points at the copy, the others keep the original.
    expect(movedA.address_id).not.toBe(addresses['mA-1']);
    const addrCopy = await db.address.findUniqueOrThrow({
      where: { id: movedA.address_id },
    });
    expect(addrCopy).toMatchObject({
      customer_id: aCloneCustomer.id,
      full_name: 'mA-1',
    });
    const stayA = await db.order.findUniqueOrThrow({
      where: { id: orders['multiA-1'] },
    });
    expect(stayA).toMatchObject({
      customer_id: customers.multiA,
      address_id: addresses['mA-1'],
    });
    expect(await db.notification.count({ where: { user_id: aClone.id } })).toBe(
      1,
    );
    expect(
      await db.notification.count({ where: { user_id: users.multiA } }),
    ).toBe(1);

    // multiB: original kept for namez; every namez-se row merged into the
    // account that already existed there, whose password is kept.
    const bRows = all.filter((u) => u.email === 'multib@example.test');
    expect(bRows).toHaveLength(2);
    const bClone = bRows.find((u) => u.id !== users.multiB)!;
    expect(bClone.id).toBe(existing.multiB.user);
    expect(bClone.store_id).toBe(stores['namez-se']);
    expect(bClone.password_hash).toBe('hash-new-multiB');
    const bc = await db.customer.findUniqueOrThrow({
      where: { user_id: bClone.id },
    });
    expect(await db.order.count({ where: { customer_id: bc.id } })).toBe(2);
    expect(
      await db.order.count({ where: { customer_id: customers.multiB } }),
    ).toBe(5);
    expect(
      await db.kustomCheckoutSession.count({ where: { customer_id: bc.id } }),
    ).toBe(1);
    expect(await db.design.count({ where: { customer_id: bc.id } })).toBe(1);
    expect(
      await db.storeCustomerTaxExemption.count({
        where: { customer_id: bc.id },
      }),
    ).toBe(1);
    expect(
      await db.promotionUsage.count({ where: { user_id: bClone.id } }),
    ).toBe(1);
    expect(
      await db.promotionUsage.count({ where: { user_id: users.multiB } }),
    ).toBe(1);
    expect(await db.notification.count({ where: { user_id: bClone.id } })).toBe(
      1,
    );
    // Reset token gone, logout marker kept, unused login token gone.
    expect(
      await db.session.findMany({
        where: { user_id: users.multiB },
        select: { token: true },
      }),
    ).toEqual([{ token: 'marker-multiB' }]);
    expect(
      await db.loginToken.count({ where: { user_id: users.multiB } }),
    ).toBe(0);
    expect(await db.session.count({ where: { token: 'reset-s5' } })).toBe(0);
    expect(await db.session.count({ where: { token: 'marker-s9' } })).toBe(1);
  });

  it('is idempotent: a second run plans and changes nothing', async () => {
    const before = await digest();
    const dry = await run(db, parseArgs([]), silent);
    expect(dry.plan.totals).toMatchObject({
      skip_already_assigned: 18,
      assign: 0,
      split: 0,
      unassigned: 0,
      clones: 0,
    });
    expect(dry.plan.customers.flatMap((c) => c.warnings)).toEqual([]);
    await run(
      db,
      parseArgs(['--apply', `--fingerprint=${dry.fingerprint}`]),
      silent,
    );
    expect(await digest()).toBe(before);
  });

  it('constraint migration (step b) applies afterwards', async () => {
    cpSync(
      join(PRISMA_DIR, 'migrations', STEP_B),
      join(tmp, 'migrations', STEP_B),
      { recursive: true },
    );
    deploy();
    const [chk] = await db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'User_customer_store_chk'`;
    expect(chk.n).toBe(1);
    // The same email may now exist once per store, but not twice in one store.
    await expect(
      db.$executeRaw`INSERT INTO "User" (id, email, password_hash, role, status, store_id, updated_at)
                     VALUES (${randomUUID()}, 'multia@example.test', 'x', 'CUSTOMER', 'ACTIVE', ${stores['namez-se']}, now())`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`INSERT INTO "User" (id, email, password_hash, role, status, updated_at)
                     VALUES (${randomUUID()}, 'nostore@example.test', 'x', 'CUSTOMER', 'ACTIVE', now())`,
    ).rejects.toThrow();
  });
});
