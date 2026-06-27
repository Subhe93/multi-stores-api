import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// AES-256-GCM encryption for secrets at rest (Stripe keys, SMTP password).
//
// Envelope-ready design: every stored value carries a version prefix so the
// algorithm or key source can evolve without breaking old rows. Today the
// root key lives in the ENCRYPTION_KEY env var (never in the database). To move
// to a KMS later, add a new version tag (e.g. "v2") whose decrypt path calls the
// KMS — old "v1" rows keep decrypting unchanged.
//
// Stored format:  v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the recommended size for GCM
const KEY_BYTES = 32; // 256-bit key

/**
 * Decode and validate the raw ENCRYPTION_KEY value into a 32-byte Buffer.
 * Accepts base64 (preferred) or hex. Throws a clear error on anything invalid
 * so a misconfigured key fails loudly at startup rather than silently.
 */
export function loadKey(raw: string | undefined): Buffer {
  if (!raw || !raw.trim()) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32',
    );
  }
  const value = raw.trim();

  // Try base64 first, then hex.
  let key: Buffer | null = null;
  const fromB64 = Buffer.from(value, 'base64');
  if (fromB64.length === KEY_BYTES) {
    key = fromB64;
  } else if (/^[0-9a-fA-F]+$/.test(value) && value.length === KEY_BYTES * 2) {
    key = Buffer.from(value, 'hex');
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${
        key?.length ?? fromB64.length
      }). Generate a valid one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** True when a stored value is already in our encrypted envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}

/** Encrypt a plaintext string into the versioned envelope format. */
export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a stored value. Values that are not in the encrypted envelope format
 * (legacy plaintext written before encryption was introduced) are returned
 * unchanged, so reads keep working during the migration window.
 */
export function decryptValue(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value; // legacy plaintext passthrough

  const parts = value.split(':');
  if (parts.length !== 4) {
    throw new Error('Malformed encrypted value: expected 4 segments');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(), // throws if the authTag check fails (tampered data)
  ]);
  return plaintext.toString('utf8');
}

/** Constant-time string comparison helper (not used for secrets here, but handy). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
