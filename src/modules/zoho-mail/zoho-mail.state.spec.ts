import { ZOHO_STATE_TTL_MS, signState, verifyState } from './zoho-mail.state';

const SECRET = 'test-secret';
const input = { storeId: 's1', userId: 'u1', region: 'zoho.eu' as const };

describe('zoho oauth state', () => {
  it('round-trips store, user, region and a nonce', () => {
    const now = 1_000_000;
    const { state, payload } = signState(SECRET, input, now);
    const res = verifyState(SECRET, state, now + 1000);
    expect(res).toEqual({ ok: true, payload });
    expect(payload).toMatchObject({ ...input, exp: now + ZOHO_STATE_TTL_MS });
    expect(payload.nonce.length).toBeGreaterThanOrEqual(16);
    expect(signState(SECRET, input, now).payload.nonce).not.toBe(payload.nonce);
  });

  it('expires after 10 minutes', () => {
    const now = 1_000_000;
    const { state } = signState(SECRET, input, now);
    expect(verifyState(SECRET, state, now + ZOHO_STATE_TTL_MS)).toEqual({
      ok: false,
      error: 'state_expired',
    });
  });

  it('rejects tampering, another secret and junk', () => {
    const { state } = signState(SECRET, input);
    const [body, sig] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()),
        storeId: 's2',
      }),
    ).toString('base64url');
    for (const bad of [
      `${forged}.${sig}`,
      `${body}.${sig.slice(0, -2)}xx`,
      body,
      '',
      'a.b.c',
      undefined,
    ]) {
      expect(verifyState(SECRET, bad)).toEqual({
        ok: false,
        error: 'invalid_state',
      });
    }
    expect(verifyState('other-secret', state)).toEqual({
      ok: false,
      error: 'invalid_state',
    });
  });
});
