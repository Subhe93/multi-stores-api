import {
  parseMerchantPolicies,
  publicMerchantPolicies,
  validateMerchantPolicies,
} from './merchant-policies';

// M170 C: rules of Store.merchant_policies (handling time + return policies).

function fieldsOf(body: unknown): string[] {
  try {
    validateMerchantPolicies(body);
  } catch (err) {
    const res = (err as { response?: { code?: string; fields?: string[] } })
      .response;
    expect(res?.code).toBe('MERCHANT_POLICIES_INVALID');
    return res?.fields ?? [];
  }
  throw new Error('expected MERCHANT_POLICIES_INVALID');
}

const finite = { countries: ['SE'], category: 'finite', days: 14 };

describe('validateMerchantPolicies: normalisation', () => {
  it('nothing configured normalises to null', () => {
    expect(validateMerchantPolicies(undefined)).toBeNull();
    expect(validateMerchantPolicies(null)).toBeNull();
    expect(validateMerchantPolicies({})).toBeNull();
    expect(validateMerchantPolicies({ returns: [] })).toBeNull();
    expect(
      validateMerchantPolicies({ handling: null, returns: null }),
    ).toBeNull();
    expect(validateMerchantPolicies({ handling: {} })).toBeNull();
    expect(
      validateMerchantPolicies({
        handling: { min_days: null, max_days: null },
      }),
    ).toBeNull();
  });

  it('keeps a full record, upper-cases countries, orders methods, drops unknown keys', () => {
    expect(
      validateMerchantPolicies({
        extra: 1,
        handling: { min_days: 1, max_days: 2, note: 'x' },
        returns: [
          {
            countries: ['se', ' no '],
            category: 'finite',
            days: 14,
            methods: ['store', 'mail'],
            fees: 'fixed',
            fee_amount: 49,
            label: 'x',
          },
          { countries: ['DE'], category: 'unlimited', fees: 'free' },
          { countries: ['US'], category: 'none' },
        ],
      }),
    ).toEqual({
      handling: { min_days: 1, max_days: 2 },
      returns: [
        {
          countries: ['SE', 'NO'],
          category: 'finite',
          days: 14,
          methods: ['mail', 'store'],
          fees: 'fixed',
          fee_amount: 49,
        },
        { countries: ['DE'], category: 'unlimited', fees: 'free' },
        { countries: ['US'], category: 'none' },
      ],
    });
  });

  it('handling only / returns only', () => {
    expect(
      validateMerchantPolicies({ handling: { min_days: 0, max_days: 0 } }),
    ).toEqual({ handling: { min_days: 0, max_days: 0 } });
    expect(validateMerchantPolicies({ returns: [finite] })).toEqual({
      returns: [finite],
    });
  });

  it('an empty methods list and null optionals mean "not stated"', () => {
    expect(
      validateMerchantPolicies({
        returns: [{ ...finite, methods: [], fees: null, fee_amount: null }],
      }),
    ).toEqual({ returns: [finite] });
  });
});

describe('validateMerchantPolicies: rules and field paths', () => {
  it('rejects a body that is not an object', () => {
    expect(fieldsOf([])).toEqual(['body']);
    expect(fieldsOf('x')).toEqual(['body']);
  });

  it('handling: both bounds or neither', () => {
    expect(fieldsOf({ handling: { min_days: 1 } })).toEqual([
      'handling.max_days',
    ]);
    expect(fieldsOf({ handling: { max_days: 1 } })).toEqual([
      'handling.min_days',
    ]);
    expect(fieldsOf({ handling: 'soon' })).toEqual([
      'handling.min_days',
      'handling.max_days',
    ]);
  });

  it('handling: integers within 0..30 and min <= max', () => {
    expect(fieldsOf({ handling: { min_days: -1, max_days: 2 } })).toEqual([
      'handling.min_days',
    ]);
    expect(fieldsOf({ handling: { min_days: 1.5, max_days: 2 } })).toEqual([
      'handling.min_days',
    ]);
    expect(fieldsOf({ handling: { min_days: '1', max_days: 2 } })).toEqual([
      'handling.min_days',
    ]);
    expect(fieldsOf({ handling: { min_days: 1, max_days: 31 } })).toEqual([
      'handling.max_days',
    ]);
    expect(fieldsOf({ handling: { min_days: 3, max_days: 2 } })).toEqual([
      'handling.max_days',
    ]);
  });

  it('returns: a list of at most 10 policies', () => {
    expect(fieldsOf({ returns: {} })).toEqual(['returns']);
    const eleven = 'ABCDEFGHIJK'
      .split('')
      .map((c) => ({ countries: [`${c}A`], category: 'unlimited' }));
    expect(fieldsOf({ returns: eleven })).toEqual(['returns']);
    expect(
      validateMerchantPolicies({ returns: eleven.slice(0, 10) })?.returns,
    ).toHaveLength(10);
  });

  it('countries: required, ISO2, 1..50, distinct inside a policy', () => {
    for (const countries of [
      undefined,
      [],
      ['SWE'],
      ['S1'],
      [5],
      ['SE', 'se'],
    ]) {
      expect(fieldsOf({ returns: [{ ...finite, countries }] })).toEqual([
        'returns.0.countries',
      ]);
    }
    const many = Array.from({ length: 51 }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
    );
    expect(fieldsOf({ returns: [{ ...finite, countries: many }] })).toEqual([
      'returns.0.countries',
    ]);
    expect(
      validateMerchantPolicies({
        returns: [{ ...finite, countries: many.slice(0, 50) }],
      })?.returns?.[0].countries,
    ).toHaveLength(50);
  });

  it('a country may appear in one policy only (the later policy is named)', () => {
    expect(
      fieldsOf({
        returns: [finite, { countries: ['NO', 'SE'], category: 'unlimited' }],
      }),
    ).toEqual(['returns.1.countries']);
  });

  it('category is required and known', () => {
    expect(fieldsOf({ returns: [{ countries: ['SE'] }] })).toEqual([
      'returns.0.category',
    ]);
    expect(
      fieldsOf({ returns: [{ countries: ['SE'], category: 'maybe' }] }),
    ).toEqual(['returns.0.category']);
    expect(fieldsOf({ returns: ['x'] })).toEqual([
      'returns.0.countries',
      'returns.0.category',
    ]);
  });

  it('days: only and always with a finite window, 1..365', () => {
    for (const days of [undefined, 0, 366, 1.5, '14']) {
      expect(fieldsOf({ returns: [{ ...finite, days }] })).toEqual([
        'returns.0.days',
      ]);
    }
    for (const category of ['unlimited', 'none']) {
      expect(
        fieldsOf({ returns: [{ countries: ['SE'], category, days: 14 }] }),
      ).toEqual(['returns.0.days']);
    }
  });

  it('methods: known, distinct, never with "none"', () => {
    expect(fieldsOf({ returns: [{ ...finite, methods: ['post'] }] })).toEqual([
      'returns.0.methods',
    ]);
    expect(
      fieldsOf({ returns: [{ ...finite, methods: ['mail', 'mail'] }] }),
    ).toEqual(['returns.0.methods']);
    expect(fieldsOf({ returns: [{ ...finite, methods: 'mail' }] })).toEqual([
      'returns.0.methods',
    ]);
    expect(
      fieldsOf({
        returns: [{ countries: ['SE'], category: 'none', methods: ['mail'] }],
      }),
    ).toEqual(['returns.0.methods']);
  });

  it('fees: known, never with "none"', () => {
    expect(fieldsOf({ returns: [{ ...finite, fees: 'cheap' }] })).toEqual([
      'returns.0.fees',
    ]);
    expect(
      fieldsOf({
        returns: [{ countries: ['SE'], category: 'none', fees: 'free' }],
      }),
    ).toEqual(['returns.0.fees']);
  });

  it('fee_amount: only and always with a fixed fee, > 0, two decimals', () => {
    for (const fee_amount of [undefined, 0, -5, 4.999, '49', 1_000_001]) {
      expect(
        fieldsOf({ returns: [{ ...finite, fees: 'fixed', fee_amount }] }),
      ).toEqual(['returns.0.fee_amount']);
    }
    expect(
      fieldsOf({ returns: [{ ...finite, fees: 'free', fee_amount: 49 }] }),
    ).toEqual(['returns.0.fee_amount']);
    expect(fieldsOf({ returns: [{ ...finite, fee_amount: 49 }] })).toEqual([
      'returns.0.fee_amount',
    ]);
    expect(
      validateMerchantPolicies({
        returns: [{ ...finite, fees: 'fixed', fee_amount: 49.9 }],
      })?.returns?.[0].fee_amount,
    ).toBe(49.9);
  });

  it('reports every offending field once, across handling and policies', () => {
    expect(
      fieldsOf({
        handling: { min_days: 5, max_days: 1 },
        returns: [
          finite,
          { countries: ['SE'], category: 'finite' },
          { countries: [], category: 'none', days: 3 },
        ],
      }),
    ).toEqual([
      'handling.max_days',
      'returns.1.countries',
      'returns.1.days',
      'returns.2.countries',
      'returns.2.days',
    ]);
  });
});

describe('parseMerchantPolicies (fail-closed reader)', () => {
  it('reads a valid stored value', () => {
    const stored = {
      handling: { min_days: 1, max_days: 2 },
      returns: [finite],
    };
    expect(parseMerchantPolicies(stored)).toEqual(stored);
  });

  it('reads anything else as not configured', () => {
    for (const raw of [
      null,
      undefined,
      'x',
      5,
      [],
      {},
      { handling: { min_days: 5, max_days: 1 } },
      { returns: [{ countries: ['SE'], category: 'finite' }] },
      // One broken policy closes the whole value: never a partial repair.
      { returns: [finite, { countries: ['NO'], category: 'later' }] },
    ]) {
      expect(parseMerchantPolicies(raw)).toBeNull();
    }
  });
});

describe('publicMerchantPolicies', () => {
  const policies = {
    handling: { min_days: 1, max_days: 2 },
    returns: [
      {
        countries: ['SE', 'NO', 'DK'],
        category: 'finite' as const,
        days: 14,
        methods: ['mail' as const],
        fees: 'fixed' as const,
        fee_amount: 49,
      },
      { countries: ['DE', 'AT'], category: 'none' as const },
    ],
  };

  it('nothing configured adds no key', () => {
    expect(publicMerchantPolicies(null, ['SE'], null)).toEqual({});
  });

  it('narrows policies to the requested countries, in request order', () => {
    expect(publicMerchantPolicies(policies, ['DK', 'AT', 'SE'], null)).toEqual({
      handling_days: { min: 1, max: 2 },
      return_policies: [
        {
          countries: ['DK', 'SE'],
          category: 'finite',
          days: 14,
          methods: ['mail'],
          fees: 'fixed',
          fee_amount: 49,
        },
        { countries: ['AT'], category: 'none' },
      ],
    });
  });

  it('no policy covers the request: the key is absent, handling stays', () => {
    const out = publicMerchantPolicies(policies, ['US'], null);
    expect(out).toEqual({ handling_days: { min: 1, max: 2 } });
    expect('return_policies' in out).toBe(false);
  });

  it('returns only: no handling key', () => {
    const out = publicMerchantPolicies(
      { returns: policies.returns },
      ['DE'],
      null,
    );
    expect(out).toEqual({
      return_policies: [{ countries: ['DE'], category: 'none' }],
    });
    expect('handling_days' in out).toBe(false);
  });

  it('converts the fixed fee with the market converter', () => {
    const out = publicMerchantPolicies(policies, ['SE'], (a) => a / 10);
    expect(out.return_policies?.[0].fee_amount).toBeCloseTo(4.9);
  });

  it('never hands out the stored arrays', () => {
    const out = publicMerchantPolicies(policies, ['SE'], null);
    expect(out.return_policies?.[0].methods).not.toBe(
      policies.returns[0].methods,
    );
  });
});

// M172: the personalised-products exception.
describe('personalized_no_returns (M172)', () => {
  it('true is kept next to a return policy, as the last key', () => {
    const out = validateMerchantPolicies({
      personalized_no_returns: true,
      returns: [finite],
      handling: { min_days: 1, max_days: 2 },
    });
    expect(out).toEqual({
      handling: { min_days: 1, max_days: 2 },
      returns: [finite],
      personalized_no_returns: true,
    });
    expect(Object.keys(out ?? {})).toEqual([
      'handling',
      'returns',
      'personalized_no_returns',
    ]);
  });

  it('false, null and absent all store no key (same record as before M172)', () => {
    const plain = validateMerchantPolicies({ returns: [finite] });
    for (const value of [false, null, undefined]) {
      const out = validateMerchantPolicies({
        returns: [finite],
        personalized_no_returns: value,
      });
      expect(JSON.stringify(out)).toBe(JSON.stringify(plain));
    }
  });

  it('is dropped without a return policy', () => {
    expect(validateMerchantPolicies({ personalized_no_returns: true })).toBe(
      null,
    );
    expect(
      validateMerchantPolicies({
        handling: { min_days: 1, max_days: 2 },
        returns: [],
        personalized_no_returns: true,
      }),
    ).toEqual({ handling: { min_days: 1, max_days: 2 } });
  });

  it('is strictly a boolean', () => {
    for (const value of ['true', 'false', 1, 0, {}, []]) {
      expect(
        fieldsOf({ returns: [finite], personalized_no_returns: value }),
      ).toEqual(['personalized_no_returns']);
    }
  });

  it('survives the validate / parse round trip; a malformed flag closes the value', () => {
    const stored = validateMerchantPolicies({
      returns: [finite],
      personalized_no_returns: true,
    });
    expect(parseMerchantPolicies(stored)).toEqual(stored);
    expect(validateMerchantPolicies(parseMerchantPolicies(stored))).toEqual(
      stored,
    );
    expect(
      parseMerchantPolicies({
        returns: [finite],
        personalized_no_returns: 'yes',
      }),
    ).toBeNull();
  });

  describe('publicMerchantPolicies', () => {
    const base = {
      handling: { min_days: 1, max_days: 2 },
      returns: [
        {
          countries: ['SE', 'NO', 'DK'],
          category: 'finite' as const,
          days: 14,
          methods: ['mail' as const],
          fees: 'fixed' as const,
          fee_amount: 49,
        },
        { countries: ['DE', 'AT'], category: 'unlimited' as const },
      ],
    };
    const on = { ...base, personalized_no_returns: true as const };
    const request = ['AT', 'SE', 'US', 'NO'];

    it('flag on + personalised: one "none" policy for the covered countries, in request order', () => {
      const out = publicMerchantPolicies(on, request, (a) => a / 10, true);
      expect(out).toEqual({
        handling_days: { min: 1, max: 2 },
        return_policies: [{ countries: ['AT', 'SE', 'NO'], category: 'none' }],
      });
      expect(Object.keys(out.return_policies?.[0] ?? {})).toEqual([
        'countries',
        'category',
      ]);
    });

    it('flag on + personalised, nothing covered: no return_policies key', () => {
      const out = publicMerchantPolicies(on, ['US'], null, true);
      expect(out).toEqual({ handling_days: { min: 1, max: 2 } });
    });

    it('flag on + plain product: the store policies, unchanged', () => {
      expect(JSON.stringify(publicMerchantPolicies(on, request, null))).toBe(
        JSON.stringify(publicMerchantPolicies(base, request, null)),
      );
      expect(
        JSON.stringify(publicMerchantPolicies(on, request, null, false)),
      ).toBe(JSON.stringify(publicMerchantPolicies(base, request, null)));
    });

    it('flag off + personalised: the store policies, unchanged', () => {
      expect(
        JSON.stringify(publicMerchantPolicies(base, request, null, true)),
      ).toBe(JSON.stringify(publicMerchantPolicies(base, request, null)));
    });
  });
});
