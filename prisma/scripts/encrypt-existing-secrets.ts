/**
 * One-time migration: encrypt any plaintext secrets still stored in the
 * database — PlatformConfig (Stripe secret key, Stripe webhook secrets, SMTP
 * password), StoreMailSettings (SMTP password) and Creator (Kustom shared
 * secret).
 *
 * Idempotent — values already in the encrypted envelope format are skipped, so
 * it is safe to run more than once. Every new ciphertext is decrypted again
 * and compared with the original before it is written. Values are never
 * printed; only field names and counts are. Requires ENCRYPTION_KEY.
 *
 * Run with:  npx ts-node prisma/scripts/encrypt-existing-secrets.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  decryptValue,
  encryptValue,
  isEncrypted,
  loadKey,
} from '../../src/common/crypto/crypto.util';

const prisma = new PrismaClient();

/** Encrypt the plaintext fields of one row; returns only what must change. */
function encryptFields(
  row: Record<string, unknown>,
  fields: readonly string[],
  key: Buffer,
  label: string,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const field of fields) {
    const value = row[field];
    if (typeof value !== 'string' || !value || isEncrypted(value)) continue;
    const encrypted = encryptValue(value, key);
    if (decryptValue(encrypted, key) !== value) {
      throw new Error(`Round-trip check failed for ${label}.${field}`);
    }
    data[field] = encrypted;
    console.log(`  • encrypting ${label}.${field}`);
  }
  return data;
}

async function main(): Promise<void> {
  const key = loadKey(process.env.ENCRYPTION_KEY);
  let encryptedFields = 0;

  const platformFields = [
    'stripe_secret_key',
    'stripe_webhook_secret',
    'stripe_connect_webhook_secret',
    'smtp_pass',
  ] as const;
  const configs = await prisma.platformConfig.findMany({
    select: {
      id: true,
      stripe_secret_key: true,
      stripe_webhook_secret: true,
      stripe_connect_webhook_secret: true,
      smtp_pass: true,
    },
  });
  for (const row of configs) {
    const data = encryptFields(row, platformFields, key, 'PlatformConfig');
    if (Object.keys(data).length > 0) {
      await prisma.platformConfig.update({ where: { id: row.id }, data });
      encryptedFields += Object.keys(data).length;
    }
  }

  const storeMail = await prisma.storeMailSettings.findMany({
    select: { id: true, smtp_pass: true },
  });
  for (const row of storeMail) {
    const data = encryptFields(row, ['smtp_pass'], key, 'StoreMailSettings');
    if (Object.keys(data).length > 0) {
      await prisma.storeMailSettings.update({ where: { id: row.id }, data });
      encryptedFields += 1;
    }
  }

  const creators = await prisma.creator.findMany({
    where: { kustom_shared_secret: { not: null } },
    select: { id: true, kustom_shared_secret: true },
  });
  for (const row of creators) {
    const data = encryptFields(row, ['kustom_shared_secret'], key, 'Creator');
    if (Object.keys(data).length > 0) {
      await prisma.creator.update({ where: { id: row.id }, data });
      encryptedFields += 1;
    }
  }

  console.log(`Done. Encrypted ${encryptedFields} field(s).`);
}

main()
  .catch((err) => {
    console.error(
      'Encryption migration failed:',
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
