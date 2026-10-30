import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isZohoRegion, type ZohoRegion } from './zoho-mail.client';

/**
 * OAuth `state` for the Zoho connect flow: base64url(JSON payload) + "." +
 * base64url(HMAC-SHA256). Bound to the store, the user and the region, with
 * a random nonce and a 10-minute expiry.
 */

export const ZOHO_STATE_TTL_MS = 10 * 60 * 1000;

export interface ZohoStatePayload {
  storeId: string;
  userId: string;
  region: ZohoRegion;
  nonce: string;
  /** Expiry, epoch ms. */
  exp: number;
}

export type ZohoStateError = 'invalid_state' | 'state_expired';

/** Domain-separated key so the state MAC never doubles as another token. */
function macKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('zoho-mail-oauth-state').digest();
}

function mac(secret: string, body: string): string {
  return createHmac('sha256', macKey(secret)).update(body).digest('base64url');
}

export function signState(
  secret: string,
  input: { storeId: string; userId: string; region: ZohoRegion },
  now = Date.now(),
): { state: string; payload: ZohoStatePayload } {
  const payload: ZohoStatePayload = {
    storeId: input.storeId,
    userId: input.userId,
    region: input.region,
    nonce: randomBytes(16).toString('base64url'),
    exp: now + ZOHO_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { state: `${body}.${mac(secret, body)}`, payload };
}

export function verifyState(
  secret: string,
  state: string | undefined | null,
  now = Date.now(),
):
  | { ok: true; payload: ZohoStatePayload }
  | { ok: false; error: ZohoStateError } {
  if (!state || typeof state !== 'string' || state.length > 2048) {
    return { ok: false, error: 'invalid_state' };
  }
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'invalid_state' };
  }
  const [body, sig] = parts;
  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, error: 'invalid_state' };
  }
  let payload: ZohoStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as ZohoStatePayload;
  } catch {
    return { ok: false, error: 'invalid_state' };
  }
  if (
    !payload ||
    typeof payload.storeId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number' ||
    !isZohoRegion(payload.region)
  ) {
    return { ok: false, error: 'invalid_state' };
  }
  if (payload.exp <= now) return { ok: false, error: 'state_expired' };
  return { ok: true, payload };
}
