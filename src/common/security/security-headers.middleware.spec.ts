import {
  applySecurityHeaders,
  isFrameableResourcePath,
  securityHeadersFor,
  securityHeadersMiddleware,
} from './security-headers.middleware';

function fakeRes(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    getHeader: (name: string) => store.get(name.toLowerCase()),
    setHeader: (name: string, value: string) => {
      store.set(name.toLowerCase(), value);
    },
    headers: () => Object.fromEntries(store),
  };
}

describe('securityHeadersFor', () => {
  it('sets nosniff, referrer policy and X-Frame-Options DENY on an API route', () => {
    expect(securityHeadersFor({ path: '/api/products', secure: false })).toEqual(
      {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'DENY',
      },
    );
  });

  it('adds HSTS only when the request is secure', () => {
    expect(
      securityHeadersFor({ path: '/api/products', secure: false }),
    ).not.toHaveProperty('Strict-Transport-Security');
    expect(
      securityHeadersFor({ path: '/api/products', secure: true })[
        'Strict-Transport-Security'
      ],
    ).toBe('max-age=31536000; includeSubDomains');
  });

  it.each([
    '/uploads/abc.png',
    '/api/uploads/customer/42/original',
    '/api/designer/fonts/foo.woff2',
    '/api/designer/assets/bg.png',
    '/api/designer/files/token123',
    '/api/designer/my/orders/o1/items/i1/print',
    '/api/designer/my/orders/o1/items/i1/originals/a1',
    '/api/invoices/documents/inv1/pdf',
    '/api/feeds/shop/tok/google.xml',
    '/api/feeds/shop/tok/facebook.csv',
  ])('skips X-Frame-Options on resource route %s', (path) => {
    expect(isFrameableResourcePath(path)).toBe(true);
    const headers = securityHeadersFor({ path, secure: true });
    expect(headers).not.toHaveProperty('X-Frame-Options');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it.each([
    '/api/designer/my/fonts',
    '/api/designer/my/orders/o1/designs',
    '/api/invoices/documents/orders/o1',
    '/api/feeds',
    '/api/uploads',
    '/api/uploads/customer',
  ])('keeps X-Frame-Options on JSON route %s', (path) => {
    expect(isFrameableResourcePath(path)).toBe(false);
    expect(securityHeadersFor({ path, secure: true })['X-Frame-Options']).toBe(
      'DENY',
    );
  });
});

describe('applySecurityHeaders', () => {
  it('never overrides a header that is already set', () => {
    const res = fakeRes({
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    applySecurityHeaders({ path: '/api/x', secure: true }, res);
    expect(res.headers()).toEqual({
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'SAMEORIGIN',
      'x-content-type-options': 'nosniff',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    });
  });
});

describe('securityHeadersMiddleware', () => {
  it('reads req.path / req.secure and calls next()', () => {
    const res = fakeRes();
    const next = jest.fn();
    securityHeadersMiddleware(
      { path: '/api/orders', secure: true } as never,
      res as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['strict-transport-security']).toBeDefined();
  });
});
