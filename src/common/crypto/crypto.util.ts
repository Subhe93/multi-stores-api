import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// AES-256-GCM encryption for secrets at rest (Stripe keys, SMTP password).
//
// Envelope-ready design: every stored value carries a version prefix so the
// algorithm or key source can evolve without breaking old rows. The 32-byte
// data key lives in memory only; it comes either from the ENCRYPTION_KEY env
// var or (Phase 4) from a KMS-wrapped copy unwrapped at startup. The database
// never sees the key.
//
// Stored formats:
//   v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>
//   v2:<keyId>:<base64 iv>:<base64 authTag>:<base64 ciphertext>
//
// `v2` adds the id of the data key the value was encrypted with, so a future
// data-key rotation can tell old rows from new ones. The key id is the first
// 8 bytes of sha256(dataKey), hex encoded (16 hex chars); it reveals nothing
// about the key. Encrypt still produces `v1` today: the data key does not
// change when the KMS envelope is enabled, so no row needs rewriting.

const VERSION = 'v1';
const VERSION_V2 = 'v2';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the recommended size for GCM
const KEY_BYTES = 32; // 256-bit key
const KEY_ID_BYTES = 8;

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

/**
 * Validate a raw 32-byte key buffer (e.g. the KMS Decrypt plaintext). Same
 * guarantees as loadKey() for a key that did not come from a string.
 */
export function assertKeyBytes(
  key: Uint8Array | undefined,
  label: string,
): Buffer {
  if (!key || key.length !== KEY_BYTES) {
    throw new Error(
      `${label} must be exactly ${KEY_BYTES} bytes (got ${key?.length ?? 0})`,
    );
  }
  return Buffer.from(key);
}

/** Short, non-secret identifier of a data key: sha256(key)[0..8] as hex. */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256')
    .update(key)
    .digest()
    .subarray(0, KEY_ID_BYTES)
    .toString('hex');
}

/** True when a stored value is already in our encrypted envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(`${VERSION}:`) || value.startsWith(`${VERSION_V2}:`))
  );
}

function seal(plaintext: string, key: Buffer): [string, string, string] {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ];
}

function open(
  ivB64: string,
  tagB64: string,
  dataB64: string,
  key: Buffer,
): string {
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

/** Encrypt a plaintext string into the versioned envelope format (`v1`). */
export function encryptValue(plaintext: string, key: Buffer): string {
  return [VERSION, ...seal(plaintext, key)].join(':');
}

/**
 * Encrypt into the `v2` format that carries the data-key id. Not used by the
 * service yet (rows stay `v1` until a data-key rotation needs the id); it is
 * here so the decrypt path can be exercised and so a future rotation has a
 * writer ready.
 */
export function encryptValueV2(plaintext: string, key: Buffer): string {
  return [VERSION_V2, keyIdOf(key), ...seal(plaintext, key)].join(':');
}

/**
 * Decrypt a stored value. Values that are not in the encrypted envelope format
 * (legacy plaintext written before encryption was introduced) are returned
 * unchanged, so reads keep working during the migration window.
 *
 * A `v2` value names the key it was encrypted with; it is only decrypted when
 * that id matches the current key, otherwise a clear error is thrown instead
 * of a misleading auth-tag failure.
 */
export function decryptValue(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value; // legacy plaintext passthrough

  const parts = value.split(':');
  if (parts[0] === VERSION_V2) {
    if (parts.length !== 5) {
      throw new Error('Malformed encrypted value: expected 5 segments for v2');
    }
    const [, keyId, ivB64, tagB64, dataB64] = parts;
    const current = keyIdOf(key);
    if (keyId !== current) {
      throw new Error(
        `Encrypted value uses data key ${keyId}, but the current key is ${current}`,
      );
    }
    return open(ivB64, tagB64, dataB64, key);
  }

  if (parts.length !== 4) {
    throw new Error('Malformed encrypted value: expected 4 segments');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  return open(ivB64, tagB64, dataB64, key);
}

/** Constant-time string comparison helper (not used for secrets here, but handy). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
