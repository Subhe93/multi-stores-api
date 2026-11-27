/**
 * M175 one-off audit: recipient data of EXISTING Kustom orders.
 *
 * Before M175 the "c/o" line of Kustom's shipping address and the name on
 * its billing address (the buyer) were not stored. This script reads every
 * Kustom order from Kustom's Order Management API (GET only) and compares:
 *   - shipping_address.care_of   with Address.care_of of the order's address
 *   - billing name               with Order.buyer_name
 *
 * README
 * ------
 * Run on the server from the API directory, after the M175 build and both
 * M175 migrations, with the production environment loaded:
 *
 *   cd <api dir>; set -a; . ./.env; set +a
 *   node scripts/ops/m175-kustom-recipient-audit.js              (dry run)
 *   node scripts/ops/m175-kustom-recipient-audit.js --apply      (write)
 *
 * Options:
 *   --store=<slug>       only this store
 *   --backup-dir=<dir>   see scripts/ops/backup-dir.js
 *
 * Output: one line per order with the order number and flags only. It never
 * prints names, addresses, emails, phone numbers, credentials or
 * DATABASE_URL.
 *
 * What --apply writes
 * -------------------
 *   - A missing or different c/o: a NEW Address row (copy of the current
 *     one plus care_of) and the order is re-pointed to it. The old row is
 *     left untouched, because other orders of the customer may use it. This
 *     is what KustomService.syncShippingAddress does on a push replay.
 *   - Order.buyer_name when it is NULL and Kustom reports a billing name.
 * Nothing else is touched: no order status, no amounts, no Kustom writes.
 * A JSON backup of the previous address_id / buyer_name of every changed
 * order is written first. Rollback: set those two columns back from it.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { resolveBackupDir, checkBackupDir } = require('./backup-dir');

const dist = (p) => require(path.join(__dirname, '..', '..', 'dist', 'src', p));

const APPLY = process.argv.includes('--apply');
const storeArg = process.argv.find((a) => a.startsWith('--store='));
const STORE_SLUG = storeArg ? storeArg.slice('--store='.length).trim() : '';

const norm = (v) => (v ?? '').trim().toLowerCase();

async function main() {
  const { CryptoService } = dist('common/crypto/crypto.service.js');
  const { KustomClient } = dist('modules/payments/kustom/kustom.client.js');
  const { kustomCareOf, kustomBuyerName } = dist(
    'modules/payments/kustom/kustom.mapper.js',
  );
  if (typeof kustomCareOf !== 'function' || typeof kustomBuyerName !== 'function') {
    throw new Error('dist/ is older than M175: build the API first.');
  }

  const backupDir = resolveBackupDir();
  const dirCheck = checkBackupDir(backupDir);
  if (!dirCheck.ok) throw new Error(`Backup dir not writable: ${dirCheck.error}`);
  if (dirCheck.warning) console.log(dirCheck.warning);

  // Same key source as the running API (env or KMS-wrapped key).
  const crypto = new CryptoService({ get: (k) => process.env[k] });
  await crypto.onModuleInit();

  const prisma = new PrismaClient();
  try {
    const platform = await prisma.platformConfig.findFirst({
      select: { kustom_partner_id: true },
    });
    // Order has no Prisma relation to Store (store_id is a plain column).
    const stores = await prisma.store.findMany({
      where: STORE_SLUG ? { slug: STORE_SLUG } : {},
      select: {
        id: true,
        slug: true,
        creator: {
          select: {
            kustom_merchant_id: true,
            kustom_shared_secret: true,
            kustom_environment: true,
          },
        },
      },
    });
    const storeById = new Map(stores.map((s) => [s.id, s]));
    if (STORE_SLUG && stores.length === 0) {
      throw new Error(`No store with slug ${STORE_SLUG}`);
    }
    const orders = await prisma.order.findMany({
      where: {
        kustom_order_id: { not: null },
        deleted_at: null,
        ...(STORE_SLUG ? { store_id: { in: stores.map((s) => s.id) } } : {}),
      },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        order_number: true,
        kustom_order_id: true,
        buyer_name: true,
        store_id: true,
        address_id: true,
        address: true,
      },
    });

    console.log(
      `${APPLY ? 'APPLY' : 'DRY RUN'}: ${orders.length} Kustom order(s)` +
        (STORE_SLUG ? ` in store ${STORE_SLUG}` : ''),
    );

    const totals = {
      read: 0,
      unreadable: 0,
      careOfMissing: 0,
      careOfSame: 0,
      careOfNone: 0,
      buyerNameMissing: 0,
      recipientOtherPerson: 0,
      written: 0,
    };
    const backup = [];

    for (const order of orders) {
      const store = order.store_id ? storeById.get(order.store_id) : null;
      const slug = store?.slug ?? '(no store)';
      const creator = store?.creator;
      const secret = creator ? crypto.decrypt(creator.kustom_shared_secret) : null;
      if (!creator?.kustom_merchant_id || !secret) {
        totals.unreadable += 1;
        console.log(`${order.order_number} [${slug}] SKIP: no Kustom credentials`);
        continue;
      }
      const client = new KustomClient({
        merchantId: creator.kustom_merchant_id,
        sharedSecret: secret,
        environment:
          creator.kustom_environment === 'production' ? 'production' : 'playground',
        partnerId: platform?.kustom_partner_id || null,
      });

      let live;
      try {
        live = await client.getOrder(order.kustom_order_id);
      } catch (err) {
        totals.unreadable += 1;
        // Status only: the error body may echo order data.
        console.log(
          `${order.order_number} [${slug}] SKIP: Kustom read failed (HTTP ${
            err && err.status ? err.status : 'n/a'
          })`,
        );
        continue;
      }
      totals.read += 1;

      const remote = live.shipping_address ?? live.billing_address;
      const careOf = kustomCareOf(remote);
      const buyerName = kustomBuyerName(live.billing_address, live.shipping_address);

      const careOfState = !careOf
        ? 'none'
        : norm(order.address.care_of) === norm(careOf)
          ? 'stored'
          : 'MISSING';
      const buyerState = !buyerName
        ? 'none'
        : order.buyer_name
          ? 'stored'
          : 'MISSING';
      const otherPerson =
        !!buyerName && norm(buyerName) !== norm(order.address.full_name);

      if (careOfState === 'none') totals.careOfNone += 1;
      if (careOfState === 'stored') totals.careOfSame += 1;
      if (careOfState === 'MISSING') totals.careOfMissing += 1;
      if (buyerState === 'MISSING') totals.buyerNameMissing += 1;
      if (otherPerson) totals.recipientOtherPerson += 1;

      console.log(
        `${order.order_number} [${slug}] c/o: ${careOfState}; buyer name: ${buyerState}; ` +
          `recipient is another person: ${otherPerson ? 'yes' : 'no'}`,
      );

      if (!APPLY || (careOfState !== 'MISSING' && buyerState !== 'MISSING')) continue;

      backup.push({
        order_id: order.id,
        order_number: order.order_number,
        address_id: order.address_id,
        buyer_name: order.buyer_name,
      });
      // Written before the change, so a crash mid-run still leaves the record.
      const file = path.join(backupDir, `m175-recipient-before-${RUN_STAMP}.json`);
      fs.writeFileSync(file, JSON.stringify(backup, null, 2));

      await prisma.$transaction(async (tx) => {
        const data = {};
        if (careOfState === 'MISSING') {
          const { id: _id, created_at: _created, ...copy } = order.address;
          const created = await tx.address.create({
            data: { ...copy, is_default: false, care_of: careOf },
            select: { id: true },
          });
          data.address_id = created.id;
        }
        if (buyerState === 'MISSING') data.buyer_name = buyerName;
        // Guarded on the values read above: a concurrent push wins.
        const res = await tx.order.updateMany({
          where: {
            id: order.id,
            address_id: order.address_id,
            buyer_name: order.buyer_name,
          },
          data,
        });
        if (res.count !== 1) throw new Error('order changed meanwhile; skipped');
      });
      totals.written += 1;
    }

    console.log('---');
    console.log(`Read from Kustom: ${totals.read}; unreadable: ${totals.unreadable}`);
    console.log(
      `c/o at Kustom but not stored: ${totals.careOfMissing}; stored: ${totals.careOfSame}; no c/o: ${totals.careOfNone}`,
    );
    console.log(`Buyer name not stored: ${totals.buyerNameMissing}`);
    console.log(`Recipient is another person than the buyer: ${totals.recipientOtherPerson}`);
    console.log(
      APPLY
        ? `Orders written: ${totals.written}` +
            (backup.length
              ? `; backup: ${path.join(backupDir, `m175-recipient-before-${RUN_STAMP}.json`)}`
              : '')
        : 'Dry run: nothing written.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '');

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
