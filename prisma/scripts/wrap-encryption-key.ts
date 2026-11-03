/**
 * Wrap the app data key with AWS KMS (Phase 4 of the S3/KMS plan).
 *
 * Reads ENCRYPTION_KEY from the environment (never from argv, so it is not in
 * the shell history or `ps`), calls KMS Encrypt with the fixed encryption
 * context and writes ONLY the base64 ciphertext to the --out file (mode 0600,
 * never overwrites). Prints the output path and the KMS key id, nothing else.
 *
 * Modes:
 *   --out <file>   wrap ENCRYPTION_KEY, write the ciphertext to <file>
 *   --verify       with --out: Decrypt round trip of the written value -> "OK"
 *   --check        unwrap ENCRYPTION_KEY_WRAPPED from the env -> "OK" / "FAIL"
 *                  (and compare with ENCRYPTION_KEY when it is also set)
 *
 * Env: AWS_REGION, KMS_KEY_ID (required for --out; e.g. alias/shopsdoor-envelope),
 * AWS credentials from the SDK default chain (env vars, profile or role).
 *
 * Run with:  npx ts-node prisma/scripts/wrap-encryption-key.ts --out /path/wrapped.b64 --verify
 *            npx ts-node prisma/scripts/wrap-encryption-key.ts --check
 */
import 'dotenv/config';
import { closeSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { keyIdOf, loadKey } from '../../src/common/crypto/crypto.util';
import {
  unwrapDataKey,
  wrapDataKey,
} from '../../src/common/crypto/kms-key-source';

interface Args {
  out?: string;
  verify: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { verify: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out needs a file path');
      args.out = value;
    } else if (a.startsWith('--out=')) {
      args.out = a.slice('--out='.length);
    } else if (a === '--verify') {
      args.verify = true;
    } else if (a === '--check') {
      args.check = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.check && !args.out) {
    throw new Error('Usage: --out <file> [--verify]  |  --check');
  }
  return args;
}

/** Write the ciphertext to a new 0600 file; refuses to overwrite. */
function writeSealed(path: string, content: string): string {
  const abs = resolve(path);
  let fd: number;
  try {
    fd = openSync(abs, 'wx', 0o600); // 'x' => fail if the file exists
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing file: ${abs}`);
    }
    throw err;
  }
  try {
    writeSync(fd, content + '\n');
  } finally {
    closeSync(fd);
  }
  return abs;
}

async function check(): Promise<void> {
  const wrapped = process.env.ENCRYPTION_KEY_WRAPPED?.trim();
  if (!wrapped) {
    console.log('FAIL: ENCRYPTION_KEY_WRAPPED is not set');
    process.exitCode = 1;
    return;
  }
  try {
    const key = await unwrapDataKey(wrapped, {
      region: process.env.AWS_REGION,
      keyId: process.env.KMS_KEY_ID,
    });
    const plain = process.env.ENCRYPTION_KEY?.trim();
    if (plain) {
      const expected = loadKey(plain);
      if (!expected.equals(key)) {
        console.log('FAIL: unwrapped key differs from ENCRYPTION_KEY');
        process.exitCode = 1;
        return;
      }
    }
    console.log(`OK (key id ${keyIdOf(key)})`);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    console.log(`FAIL: KMS unwrap failed (${name})`);
    process.exitCode = 1;
  }
}

async function wrap(args: Args): Promise<void> {
  const key = loadKey(process.env.ENCRYPTION_KEY);
  const kmsKeyId = process.env.KMS_KEY_ID?.trim();
  if (!kmsKeyId) {
    throw new Error('KMS_KEY_ID is not set (e.g. alias/shopsdoor-envelope)');
  }
  const region = process.env.AWS_REGION;

  const { wrappedBase64, kmsKeyId: usedKeyId } = await wrapDataKey(key, {
    region,
    keyId: kmsKeyId,
  });

  if (args.verify) {
    const back = await unwrapDataKey(wrappedBase64, {
      region,
      keyId: kmsKeyId,
    });
    if (!back.equals(key)) {
      throw new Error('Verify failed: KMS Decrypt did not return the same key');
    }
  }

  const abs = writeSealed(args.out as string, wrappedBase64);
  console.log(`Wrapped key written to ${abs}`);
  console.log(`KMS key: ${usedKeyId}`);
  console.log(`Data key id: ${keyIdOf(key)}`);
  if (args.verify) console.log('OK');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) return check();
  return wrap(args);
}

main().catch((err) => {
  // Print only the message: never the key material.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
