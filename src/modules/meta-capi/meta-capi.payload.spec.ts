import {
  META_GRAPH_API_VERSION,
  buildEventsRequestBody,
  buildPurchaseEvent,
  buildUserData,
  metaEventsUrl,
  normalizeCity,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizePostcode,
  purchaseEventId,
  sha256Hex,
  splitFullName,
} from './meta-capi.payload';
import { buildTrackingContext, readTrackingContext } from './tracking-context';

// Meta Conversions API: normalisation + hashing rules of the customer
// parameters and the shape of the Purchase event.

// Known SHA-256 vectors (lower-case hex of the normalised value).
const HASH = {
  email: '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b', // test@example.com
  phone: 'a7274f98c43038d9c630738ac54c4cd06495600f29d7904131a2474a91d3d042', // 46701234567
  anna: '55579b557896d0ce1764c47fed644f9b35f58bad620674af23f356d80ed0c503',
  svensson: 'fdc1950dfa4353c199a4cd278e3678528d232a05dc8b4ff0a72e935d2bd9c724',
  stockholm: '54d9e023f01000124d6e59eee72eaabb6ac6605a302963b50e0e3da37c21f454',
  zip: '8e3309ee6bb115d603ccf77649dcf1898d25ebd86635b35bb137dda002b0116a', // 11122
  se: 'ad9a67fefa847de87753df6794a0ae466431e76ad1fb4db58fbbe836d1dde0e7',
};

describe('sha256Hex', () => {
  it('matches the known vectors', () => {
    expect(sha256Hex('test@example.com')).toBe(HASH.email);
    expect(sha256Hex('46701234567')).toBe(HASH.phone);
    expect(sha256Hex('se')).toBe(HASH.se);
    // UTF-8 input.
    expect(sha256Hex('malmö')).toBe(
      '4266f9bb8ffe4d49e5a88d987bd582009863dafe3d74ac5e60e74c4079833f0b',
    );
  });
});

describe('normalisation', () => {
  it('email: trimmed and lower-cased', () => {
    expect(normalizeEmail('  Test@Example.COM ')).toBe('test@example.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail('not-an-email')).toBeNull();
  });

  it('phone: digits only with the country code, no leading + or 00', () => {
    expect(normalizePhone('+46 70-123 45 67')).toBe('46701234567');
    expect(normalizePhone('0046 70 123 45 67')).toBe('46701234567');
    expect(normalizePhone('+46 (0)70 123 45 67')).toBe('46701234567');
    expect(normalizePhone('(650) 555-1212', 'US')).toBe('6505551212');
    expect(normalizePhone('+1 (650) 555-1212')).toBe('16505551212');
  });

  it('phone: a national trunk-zero number gets the calling code of a known country', () => {
    expect(normalizePhone('070-123 45 67', 'SE')).toBe('46701234567');
    expect(normalizePhone('070-123 45 67', 'se')).toBe('46701234567');
    expect(normalizePhone('0151 23456789', 'DE')).toBe('4915123456789');
    // Unknown country: left as typed (digits only).
    expect(normalizePhone('070-123 45 67', 'XX')).toBe('0701234567');
    expect(normalizePhone('070-123 45 67')).toBe('0701234567');
  });

  it('phone: empty, too short or too long values are dropped', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1234567890123456')).toBeNull();
  });

  it('names: lower-cased, punctuation removed, trimmed', () => {
    expect(normalizeName('  Anna ')).toBe('anna');
    expect(normalizeName("O'Brien")).toBe('obrien');
    expect(normalizeName('Anne-Marie')).toBe('annemarie');
    expect(normalizeName('ÅSA')).toBe('åsa');
    expect(normalizeName('Anna  Maria')).toBe('anna maria');
    expect(normalizeName(' . ')).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
  });

  it('city: lower-cased without spaces, punctuation or digits', () => {
    expect(normalizeCity('Stockholm')).toBe('stockholm');
    expect(normalizeCity(' New York ')).toBe('newyork');
    expect(normalizeCity('St. Louis')).toBe('stlouis');
    expect(normalizeCity('Malmö')).toBe('malmö');
    expect(normalizeCity('')).toBeNull();
  });

  it('postcode: lower-cased without spaces or dashes; US keeps 5 digits', () => {
    expect(normalizePostcode('111 22')).toBe('11122');
    expect(normalizePostcode('SW1A 1AA', 'GB')).toBe('sw1a1aa');
    expect(normalizePostcode('94025-1234', 'US')).toBe('94025');
    expect(normalizePostcode('')).toBeNull();
  });

  it('country: two letters, lower-cased', () => {
    expect(normalizeCountry('SE')).toBe('se');
    expect(normalizeCountry(' de ')).toBe('de');
    expect(normalizeCountry('SWE')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });

  it('splitFullName: the last word is the last name', () => {
    expect(splitFullName('Anna Svensson')).toEqual({
      first: 'Anna',
      last: 'Svensson',
    });
    expect(splitFullName('Anna Maria Svensson')).toEqual({
      first: 'Anna Maria',
      last: 'Svensson',
    });
    expect(splitFullName('Anna')).toEqual({ first: 'Anna', last: null });
    expect(splitFullName('')).toEqual({ first: null, last: null });
  });
});

describe('buildUserData', () => {
  it('hashes the customer parameters and sends the browser context unhashed', () => {
    const data = buildUserData(
      {
        email: ' Test@Example.com',
        phone: '070-123 45 67',
        first_name: 'Anna',
        last_name: 'Svensson',
        city: 'Stockholm',
        postcode: '111 22',
        country_code: 'SE',
      },
      {
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0',
        fbp: 'fb.1.1700000000000.123456789',
        fbc: 'fb.1.1700000000000.AbCdEf',
      },
    );
    expect(data).toEqual({
      em: [HASH.email],
      ph: [HASH.phone],
      fn: [HASH.anna],
      ln: [HASH.svensson],
      ct: [HASH.stockholm],
      zp: [HASH.zip],
      country: [HASH.se],
      client_ip_address: '203.0.113.7',
      client_user_agent: 'Mozilla/5.0',
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.AbCdEf',
    });
  });

  it('leaves out every parameter that is missing', () => {
    expect(buildUserData({ email: 'test@example.com' }, null)).toEqual({
      em: [HASH.email],
    });
    expect(buildUserData({}, null)).toEqual({});
  });
});

describe('buildPurchaseEvent', () => {
  const order = {
    id: '0b0f6a2e-1c1d-4a55-9a53-1f2f3a4b5c6d',
    order_number: 'ORD-1001',
    total: '349.50',
    currency: 'sek',
    paid_at: new Date('2026-11-11T10:00:00.000Z'),
    items: [
      { id: 'p1', quantity: 2, unit_price: '100.00' },
      { id: 'p2', quantity: 1, unit_price: 149.5 },
      { id: 'p1', quantity: 1, unit_price: '100.00' },
    ],
    customer: { email: 'test@example.com', country_code: 'SE' },
    context: {
      source_url: 'https://shop.example.com/checkout',
      ip: '203.0.113.7',
    },
    fallback_source_url: 'https://shop.example.com',
  };

  it('builds the Purchase event Meta deduplicates with the browser pixel', () => {
    expect(buildPurchaseEvent(order)).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(Date.UTC(2026, 10, 11, 10) / 1000),
      event_id: 'purchase_0b0f6a2e-1c1d-4a55-9a53-1f2f3a4b5c6d',
      action_source: 'website',
      event_source_url: 'https://shop.example.com/checkout',
      user_data: {
        em: [HASH.email],
        country: [HASH.se],
        client_ip_address: '203.0.113.7',
      },
      custom_data: {
        currency: 'SEK',
        value: 349.5,
        content_type: 'product',
        contents: [
          { id: 'p1', quantity: 2, item_price: 100 },
          { id: 'p2', quantity: 1, item_price: 149.5 },
          { id: 'p1', quantity: 1, item_price: 100 },
        ],
        content_ids: ['p1', 'p2'],
        num_items: 4,
        order_id: 'ORD-1001',
      },
    });
  });

  it('event_id is "purchase_" + the order id', () => {
    expect(purchaseEventId('abc')).toBe('purchase_abc');
  });

  it('an unpaid order (COD) is timed now; the store URL is the fallback source', () => {
    const now = new Date('2026-11-12T08:30:15.900Z');
    const event = buildPurchaseEvent(
      { ...order, paid_at: null, context: null },
      now,
    );
    expect(event.event_time).toBe(Math.floor(now.getTime() / 1000));
    expect(event.event_source_url).toBe('https://shop.example.com');
    expect(event.user_data).toEqual({ em: [HASH.email], country: [HASH.se] });
  });

  it('omits event_source_url when nothing is known', () => {
    const event = buildPurchaseEvent({
      ...order,
      context: null,
      fallback_source_url: null,
    });
    expect('event_source_url' in event).toBe(false);
  });

  it('accepts Decimal-like amounts', () => {
    const event = buildPurchaseEvent({
      ...order,
      total: { toString: () => '12.30' },
      items: [
        { id: 'p1', quantity: 1, unit_price: { toString: () => '12.30' } },
      ],
    });
    expect(event.custom_data.value).toBe(12.3);
    expect(event.custom_data.contents[0].item_price).toBe(12.3);
  });
});

describe('request', () => {
  it('targets the versioned events endpoint of the pixel', () => {
    expect(META_GRAPH_API_VERSION).toBe('v24.0');
    expect(metaEventsUrl('123456789012345')).toBe(
      'https://graph.facebook.com/v24.0/123456789012345/events',
    );
  });

  it('carries the token in the body and the test code only when set', () => {
    const event = buildPurchaseEvent({
      id: 'o1',
      order_number: 'ORD-1',
      total: 1,
      currency: 'EUR',
      items: [],
      customer: {},
      context: null,
    });
    expect(buildEventsRequestBody(event, 'EAAtoken')).toEqual({
      data: [event],
      access_token: 'EAAtoken',
    });
    expect(buildEventsRequestBody(event, 'EAAtoken', 'TEST12345')).toEqual({
      data: [event],
      test_event_code: 'TEST12345',
      access_token: 'EAAtoken',
    });
    expect(
      'test_event_code' in buildEventsRequestBody(event, 'EAAtoken', null),
    ).toBe(false);
  });
});

describe('tracking context', () => {
  const meta = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0' };

  it('no `tracking` field = no context (the IP / user agent are not kept alone)', () => {
    expect(buildTrackingContext(undefined, meta)).toBeNull();
    expect(buildTrackingContext(null, meta)).toBeNull();
  });

  it('keeps the valid values together with the request IP and user agent', () => {
    expect(
      buildTrackingContext(
        {
          fbp: ' fb.1.1700000000000.123456789 ',
          fbc: 'fb.1.1700000000000.AbCdEf',
          source_url: 'https://shop.example.com/checkout?step=2',
        },
        meta,
      ),
    ).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.AbCdEf',
      source_url: 'https://shop.example.com/checkout?step=2',
      ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0',
    });
  });

  it('drops malformed values instead of failing the checkout', () => {
    expect(
      buildTrackingContext(
        {
          fbp: 'not-a-cookie',
          fbc: '',
          source_url: 'javascript:alert(1)',
        },
        { ip: null, userAgent: null },
      ),
    ).toEqual({});
    // An empty `tracking` object is still a context (consent evidence).
    expect(buildTrackingContext({}, meta)).toEqual({
      ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0',
    });
  });

  it('reads a stored context back, ignoring anything unexpected', () => {
    expect(readTrackingContext(null)).toBeNull();
    expect(readTrackingContext('x')).toBeNull();
    expect(readTrackingContext([])).toBeNull();
    expect(readTrackingContext({})).toEqual({});
    expect(
      readTrackingContext({
        fbp: 'fb.1.1700000000000.123456789',
        ip: '203.0.113.7',
        user_agent: 'UA',
        extra: 'ignored',
        source_url: 42,
      }),
    ).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      ip: '203.0.113.7',
      user_agent: 'UA',
    });
  });
});
