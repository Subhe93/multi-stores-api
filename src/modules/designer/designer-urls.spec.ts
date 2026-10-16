import {
  absoluteApiUrl,
  assertDesignerUrlSecret,
  designerMailLinkExpiry,
  designerMailLinkMaxDays,
  DESIGNER_FILES_PATH,
  DESIGNER_LINK_TTL,
  designerAssetPath,
  designerFontPath,
  DesignerUrlsService,
  resolveDesignerUrlSecret,
  signDesignerToken,
  verifyDesignerToken,
} from './designer-urls';

const SECRET = 'test-secret-0123456789abcdef0123456789';
const ID = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const exp = Math.floor(NOW / 1000) + 3600;

describe('designer-urls: sign / verify', () => {
  it('round-trips a payload', () => {
    const t = signDesignerToken({ k: 'proof', id: ID, s: STORE, exp }, SECRET);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyDesignerToken(t, SECRET, NOW)).toEqual({
      ok: true,
      payload: { k: 'proof', id: ID, s: STORE, exp },
    });
  });

  it('reports expiry only for an authentic token', () => {
    const t = signDesignerToken({ k: 'asset', id: ID, s: STORE, exp }, SECRET);
    expect(verifyDesignerToken(t, SECRET, exp * 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyDesignerToken(t, 'other-secret', exp * 1000)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects a tampered payload or signature', () => {
    const t = signDesignerToken(
      { k: 'photo_preview', id: ID, s: STORE, exp },
      SECRET,
    );
    const [body, sig] = t.split('.');
    // Swap the kind inside the payload, keep the old signature.
    const forged = Buffer.from(
      JSON.stringify({ k: 'oid_proof', id: ID, s: STORE, exp }),
    )
      .toString('base64url')
      .replace(/=+$/, '');
    expect(verifyDesignerToken(`${forged}.${sig}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifyDesignerToken(`${body}.${flipped}`, SECRET, NOW).ok).toBe(
      false,
    );
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of [
      '',
      'abc',
      'a.b.c',
      'x'.repeat(600) + '.y',
      '!!.??',
      null,
      42,
    ]) {
      expect(verifyDesignerToken(bad, SECRET, NOW).ok).toBe(false);
    }
    expect(verifyDesignerToken('a.b', '', NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses to sign without a secret or with a bad payload', () => {
    expect(() =>
      signDesignerToken({ k: 'proof', id: ID, s: STORE, exp }, ''),
    ).toThrow();
    expect(() =>
      signDesignerToken({ k: 'proof', id: 'nope', s: STORE, exp }, SECRET),
    ).toThrow();
    expect(() =>
      signDesignerToken({ k: 'print' as never, id: ID, s: STORE, exp }, SECRET),
    ).toThrow();
  });
});

describe('designer-urls: secret, paths, service', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('prefers DESIGNER_URL_SECRET, else derives from JWT_SECRET', () => {
    expect(
      resolveDesignerUrlSecret({
        DESIGNER_URL_SECRET: ' own ',
        JWT_SECRET: 'j',
      }),
    ).toEqual({ secret: 'own', derived: false });
    const d = resolveDesignerUrlSecret({ JWT_SECRET: 'j' });
    expect(d.derived).toBe(true);
    expect(d.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(d.secret).not.toBe('j');
    expect(resolveDesignerUrlSecret({})).toEqual({
      secret: '',
      derived: false,
    });
  });

  it('builds stable public paths and absolute URLs', () => {
    expect(designerAssetPath(ID, 'png')).toBe(`/api/designer/assets/${ID}.png`);
    expect(designerFontPath(ID, 'woff2')).toBe(
      `/api/designer/fonts/${ID}.woff2`,
    );
    expect(
      absoluteApiUrl('/api/x', { PUBLIC_API_URL: 'https://api.a.se/' }),
    ).toBe('https://api.a.se/api/x');
    expect(absoluteApiUrl('/api/x', {})).toBe('/api/x');
  });

  it('signs paths with the default editor TTL, an explicit expiry and a cap', () => {
    process.env.DESIGNER_URL_SECRET = SECRET;
    const urls = new DesignerUrlsService();
    const p = urls.signedPath('photo_preview', ID, STORE, { now: NOW });
    expect(p.startsWith(DESIGNER_FILES_PATH)).toBe(true);
    const token = p.slice(DESIGNER_FILES_PATH.length);
    const v = urls.verify(token, NOW);
    expect(v.ok && v.payload.exp).toBe(
      Math.floor(NOW / 1000) + DESIGNER_LINK_TTL.editor,
    );
    expect(urls.verify(token, NOW + 3601 * 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });

    const purgeAt = new Date(NOW + 10 * 86400 * 1000);
    const p2 = urls.signedPath('oid_proof', ID, STORE, {
      expiresAt: purgeAt,
      now: NOW,
    });
    const v2 = urls.verify(p2.slice(DESIGNER_FILES_PATH.length), NOW);
    expect(v2.ok && v2.payload.exp).toBe(Math.floor(purgeAt.getTime() / 1000));

    const far = urls.signedPath('oid_proof', ID, STORE, {
      expiresAt: new Date(NOW + 5000 * 86400 * 1000),
      now: NOW,
    });
    const v3 = urls.verify(far.slice(DESIGNER_FILES_PATH.length), NOW);
    expect(v3.ok && v3.payload.exp).toBe(
      Math.floor(NOW / 1000) + DESIGNER_LINK_TTL.max,
    );
  });
});

describe('designer-urls: production secret and email link cap', () => {
  it('production refuses to boot without its own DESIGNER_URL_SECRET', () => {
    expect(() =>
      assertDesignerUrlSecret({ NODE_ENV: 'production', JWT_SECRET: 'j' }),
    ).toThrow(/DESIGNER_URL_SECRET must be set/);
    expect(() =>
      assertDesignerUrlSecret({
        NODE_ENV: 'production',
        DESIGNER_URL_SECRET: 'short',
      }),
    ).toThrow(/at least 32/);
    expect(() =>
      assertDesignerUrlSecret({
        NODE_ENV: 'production',
        DESIGNER_URL_SECRET: SECRET,
      }),
    ).not.toThrow();
    expect(() =>
      assertDesignerUrlSecret({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('the service constructor applies the check', () => {
    const prev = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.DESIGNER_URL_SECRET;
      expect(() => new DesignerUrlsService()).toThrow(/DESIGNER_URL_SECRET/);
    } finally {
      process.env.NODE_ENV = prev.NODE_ENV;
      if (prev.DESIGNER_URL_SECRET !== undefined)
        process.env.DESIGNER_URL_SECRET = prev.DESIGNER_URL_SECRET;
    }
  });

  it('email links: purge date, floored at minDays, capped at 30 days by default', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(designerMailLinkMaxDays({})).toBe(30);
    expect(designerMailLinkMaxDays({ DESIGNER_MAIL_LINK_MAX_DAYS: '90' })).toBe(
      90,
    );
    expect(
      designerMailLinkMaxDays({ DESIGNER_MAIL_LINK_MAX_DAYS: '9999' }),
    ).toBe(365);
    expect(designerMailLinkMaxDays({ DESIGNER_MAIL_LINK_MAX_DAYS: 'x' })).toBe(
      30,
    );
    // Purge in 365 days -> 30 days.
    expect(
      designerMailLinkExpiry(NOW + 365 * day, NOW, {
        minDays: 7,
        env: {},
      }).getTime(),
    ).toBe(NOW + 30 * day);
    // Purge in 10 days -> 10 days.
    expect(
      designerMailLinkExpiry(NOW + 10 * day, NOW, {
        minDays: 7,
        env: {},
      }).getTime(),
    ).toBe(NOW + 10 * day);
    // Purge tomorrow -> the 7-day floor.
    expect(
      designerMailLinkExpiry(NOW + day, NOW, { minDays: 7, env: {} }).getTime(),
    ).toBe(NOW + 7 * day);
  });
});
