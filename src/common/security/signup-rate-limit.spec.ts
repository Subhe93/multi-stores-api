import {
  SlidingWindowLimiter,
  clientIp,
} from './signup-rate-limit';

// SPEC §2: 5 staff sign-ups per IP per hour, sliding window, keyed by the
// client address the throttler uses.

describe('SlidingWindowLimiter', () => {
  it('allows the first N hits in the window and refuses the next', () => {
    const l = new SlidingWindowLimiter(5, 3600_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(l.hit('1.2.3.4', t0 + i)).toBe(true);
    expect(l.hit('1.2.3.4', t0 + 5)).toBe(false);
    expect(l.count('1.2.3.4', t0 + 5)).toBe(6);
    // Another address is independent.
    expect(l.hit('5.6.7.8', t0 + 5)).toBe(true);
  });

  it('slides: hits older than the window no longer count', () => {
    const l = new SlidingWindowLimiter(2, 1000);
    expect(l.hit('ip', 0)).toBe(true);
    expect(l.hit('ip', 500)).toBe(true);
    expect(l.hit('ip', 900)).toBe(false);
    // t=1001: the hit at 0 has expired, two remain (500, 900) + this one = 3.
    expect(l.hit('ip', 1001)).toBe(false);
    // t=1600: only 900 and 1001 remain before this hit → 3 again; at 2000
    // only 1001 remains → allowed.
    expect(l.hit('ip', 2000)).toBe(true);
  });

  it('never limits an unknown client (null key) and can be reset', () => {
    const l = new SlidingWindowLimiter(1, 1000);
    expect(l.hit(null, 0)).toBe(true);
    expect(l.hit(undefined, 0)).toBe(true);
    expect(l.hit('ip', 0)).toBe(true);
    expect(l.hit('ip', 1)).toBe(false);
    l.reset();
    expect(l.hit('ip', 2)).toBe(true);
  });
});

describe('clientIp', () => {
  it('prefers req.ip (Express applies TRUST_PROXY), then the first XFF hop, then the socket', () => {
    expect(clientIp({ ip: '10.0.0.9', headers: { 'x-forwarded-for': '1.1.1.1' } })).toBe('10.0.0.9');
    expect(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' } })).toBe('1.1.1.1');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '::1' } })).toBe('::1');
    expect(clientIp({ headers: {} })).toBeNull();
    expect(clientIp(undefined)).toBeNull();
  });
});
