import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// TOTP (RFC 6238) with the parameters every authenticator app supports:
// HMAC-SHA1, 6 digits, 30-second steps. Dependency-free on purpose — the
// algorithm is tiny and keeping it here makes it easy to audit and test.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted on each side of "now" to absorb clock drift (±30 s). */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** New random secret: 20 bytes (160 bits, the RFC 4226 recommendation), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 30-second step index for a Unix time in milliseconds. */
export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP value (RFC 4226) of one step, zero-padded to `digits`. */
export function hotp(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
): string {
  const msg = Buffer.alloc(8);
  // Counter as a 64-bit big-endian integer (steps fit well within 2^53).
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a 6-digit code against the steps around `nowMs`. Returns the matched
 * step (so the caller can store it and refuse replays), or null. Steps at or
 * before `lastUsedStep` are never accepted.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { nowMs?: number; lastUsedStep?: number | null } = {},
): number | null {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(opts.nowMs);
  let matched: number | null = null;
  // Check every step in the window (no early exit) so timing does not depend
  // on which step matched.
  for (
    let step = current - TOTP_WINDOW;
    step <= current + TOTP_WINDOW;
    step++
  ) {
    const expected = Buffer.from(hotp(secret, step));
    const given = Buffer.from(normalized);
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.lastUsedStep != null && matched <= opts.lastUsedStep) return null;
  return matched;
}

/** otpauth:// URI that authenticator apps read from the QR code. */
export function otpauthUrl(
  secretBase32: string,
  account: string,
  issuer: string,
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────
// 10 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown
// as XXXXX-XXXXX. ~50 bits each: far beyond online guessing, so a plain
// sha256 is enough for storage (no slow hash needed).

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let raw = '';
    // 256 is not a multiple of 31; the tiny modulo bias is irrelevant at
    // this entropy level.
    for (const b of bytes)
      raw += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** Canonical form used for hashing: uppercase, no spaces or dashes. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** True when the input looks like a recovery code rather than an app code. */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[A-Z0-9]{10}$/.test(normalizeRecoveryCode(code));
}
