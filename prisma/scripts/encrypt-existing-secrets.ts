/**
 * One-time migration: encrypt any plaintext secrets already stored in
 * PlatformConfig (Stripe secret key, Stripe webhook secret, SMTP password).
 *
 * Idempotent — values already in the encrypted envelope format are skipped, so
 * it is safe to run more than once. Requires ENCRYPTION_KEY to be set.
 *
 * Run with:  npx ts-node prisma/scripts/encrypt-existing-secrets.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  encryptValue,
  isEncrypted,
  loadKey,
} from '../../src/common/crypto/crypto.util';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const key = loadKey(process.env.ENCRYPTION_KEY);

  const rows = await prisma.platformConfig.findMany({
    select: {
      id: true,
      stripe_secret_key: true,
      stripe_webhook_secret: true,
      smtp_pass: true,
    },
  });

  if (rows.length === 0) {
    console.log('No PlatformConfig rows found. Nothing to do.');
    return;
  }

  const fields = [
    'stripe_secret_key',
    'stripe_webhook_secret',
    'smtp_pass',
  ] as const;

  let updatedRows = 0;
  let encryptedFields = 0;

  for (const row of rows) {
    const data: Record<string, string> = {};
    for (const field of fields) {
      const value = row[field];
      if (value && !isEncrypted(value)) {
        data[field] = encryptValue(value, key);
        encryptedFields += 1;
        console.log(`  • encrypting ${field} on config ${row.id}`);
      }
    }
    if (Object.keys(data).length > 0) {
      await prisma.platformConfig.update({ where: { id: row.id }, data });
      updatedRows += 1;
    }
  }

  console.log(
    `Done. Encrypted ${encryptedFields} field(s) across ${updatedRows} row(s).`,
  );
}

main()
  .catch((err) => {
    console.error('Encryption migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
