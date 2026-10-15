import { GUARDS_METADATA } from '@nestjs/common/constants';
import { B2bStorefrontController } from './b2b-storefront.controller';
import { MarketsPublicController } from '../markets/markets-public.controller';

// The ThrottlerGuard is registered globally (APP_GUARD in AppModule). A
// route that also lists it in @UseGuards runs it twice per request and
// counts every call double (a 20/min limit then trips on the 11th call).
// Our public routes therefore carry only their @Throttle limits, which the
// global guard reads from the handler metadata.

const routes: [string, object, string][] = [
  [
    'POST /storefront/:slug/b2b/vat-check',
    B2bStorefrontController.prototype,
    'vatCheck',
  ],
  [
    'GET /stores/:slug/market-context',
    MarketsPublicController.prototype,
    'marketContext',
  ],
];

describe('public routes: throttled once, by the global guard', () => {
  it.each(routes)('%s has no route-level guards', (_name, proto, method) => {
    const handler = (proto as Record<string, unknown>)[method] as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, proto.constructor),
    ).toBeUndefined();
  });

  it.each(routes)(
    '%s keeps its own @Throttle limit',
    (_name, proto, method) => {
      const handler = (proto as Record<string, unknown>)[method] as object;
      const keys = Reflect.getMetadataKeys(handler).map(String);
      expect(keys.some((k) => k.includes('LIMIT'))).toBe(true);
      expect(keys.some((k) => k.includes('TTL'))).toBe(true);
    },
  );
});
