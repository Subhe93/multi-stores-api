import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isPhpSerialized,
  maybeUnserialize,
  phpUnserialize,
  PhpUnserializeError,
} from './php-unserialize';
import { parseTsv } from './tsv';
import { BUNDLE_TABLES } from './bundle-schema';

describe('phpUnserialize', () => {
  it('reads scalars', () => {
    expect(phpUnserialize('N;')).toBeNull();
    expect(phpUnserialize('b:1;')).toBe(true);
    expect(phpUnserialize('b:0;')).toBe(false);
    expect(phpUnserialize('i:-42;')).toBe(-42);
    expect(phpUnserialize('d:0.5;')).toBe(0.5);
    expect(phpUnserialize('d:1.0E+25;')).toBe(1e25);
    expect(phpUnserialize('d:INF;')).toBe(Infinity);
    expect(phpUnserialize('d:-INF;')).toBe(-Infinity);
    expect(phpUnserialize('d:NAN;')).toBeNaN();
    expect(phpUnserialize('s:0:"";')).toBe('');
  });

  it('keeps integers beyond 2^53 as decimal strings', () => {
    expect(phpUnserialize('i:9223372036854775807;')).toBe(
      '9223372036854775807',
    );
  });

  it('uses UTF-8 byte lengths for strings', () => {
    expect(phpUnserialize('s:5:"Färg";')).toBe('Färg');
    expect(phpUnserialize('s:11:"Välj antal";')).toBe('Välj antal');
    expect(phpUnserialize('s:4:"😀";')).toBe('😀');
    // Quotes and semicolons inside a string are data.
    expect(phpUnserialize('s:7:"a";"b;c";')).toBe('a";"b;c');
  });

  it('turns 0..n-1 arrays into lists and other arrays into records', () => {
    expect(phpUnserialize('a:2:{i:0;s:1:"a";i:1;s:1:"b";}')).toEqual([
      'a',
      'b',
    ]);
    expect(phpUnserialize('a:0:{}')).toEqual([]);
    expect(phpUnserialize('a:2:{i:1;s:1:"a";i:0;s:1:"b";}')).toEqual({
      '1': 'a',
      '0': 'b',
    });
    expect(phpUnserialize('a:1:{s:3:"key";a:1:{i:0;i:3735;}}')).toEqual({
      key: [3735],
    });
  });

  it('can preserve source order of mixed keys', () => {
    expect(
      phpUnserialize('a:2:{s:1:"z";i:1;i:5;i:2;}', { preserveOrder: true }),
    ).toEqual({
      __entries__: [
        ['z', 1],
        [5, 2],
      ],
    });
  });

  it('reads objects as plain records without instantiating anything', () => {
    const v = phpUnserialize(
      'O:8:"stdClass":2:{s:1:"a";i:1;s:4:"\0*\0b";s:1:"x";}',
    ) as Record<string, unknown>;
    expect(v).toEqual({ __class__: 'stdClass', a: 1, b: 'x' });
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });

  it('does not pollute prototypes', () => {
    const v = phpUnserialize(
      'a:1:{s:9:"__proto__";a:1:{s:8:"polluted";b:1;}}',
    ) as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((v as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    ['s:10:"short";', /runs past the end/],
    ['s:3:"abcd";', /expected '"'/],
    ['a:2:{i:0;i:1;}', /array keys must be int or string|unexpected end/],
    ['i:12x;', /invalid integer/],
    ['b:2;', /invalid boolean/],
    ['x:1;', /unknown type/],
    ['a:1:{i:0;r:1;}', /references/],
    ['C:3:"Foo":0:{}', /custom-serialized/],
    ['i:1;garbage', /trailing data/],
    ['', /unexpected end/],
    ['a:1:{d:1.5;i:1;}', /array keys/],
  ])('rejects malformed input %j with an error, not a crash', (input, re) => {
    expect(() => phpUnserialize(input)).toThrow(PhpUnserializeError);
    expect(() => phpUnserialize(input)).toThrow(re);
  });

  it('enforces depth, string and element limits', () => {
    const deep = 'a:1:{i:0;'.repeat(70) + 'N;' + '}'.repeat(70);
    expect(() => phpUnserialize(deep)).toThrow(/maximum depth/);
    expect(
      phpUnserialize('a:1:{i:0;'.repeat(10) + 'N;' + '}'.repeat(10)),
    ).toBeDefined();
    expect(() =>
      phpUnserialize('s:20:"aaaaaaaaaaaaaaaaaaaa";', { maxStringBytes: 10 }),
    ).toThrow(/size limit/);
    expect(() =>
      phpUnserialize('a:3:{i:0;i:1;i:1;i:2;i:2;i:3;}', { maxElements: 4 }),
    ).toThrow(/too many elements/);
    expect(() => phpUnserialize('a:99999999999:{}')).toThrow(
      PhpUnserializeError,
    );
  });
});

describe('isPhpSerialized / maybeUnserialize', () => {
  it('detects serialized strings like WordPress', () => {
    expect(isPhpSerialized('a:0:{}')).toBe(true);
    expect(isPhpSerialized('s:3:"abc";')).toBe(true);
    expect(isPhpSerialized('i:5;')).toBe(true);
    expect(isPhpSerialized('N;')).toBe(true);
    expect(isPhpSerialized('yes')).toBe(false);
    expect(isPhpSerialized('{"double":false}')).toBe(false);
    expect(isPhpSerialized('4100,4101')).toBe(false);
  });

  it('returns plain strings unchanged and reports broken values', () => {
    expect(maybeUnserialize('valj-antal')).toEqual({
      ok: true,
      serialized: false,
      value: 'valj-antal',
    });
    expect(maybeUnserialize(null)).toEqual({
      ok: true,
      serialized: false,
      value: null,
    });
    expect(maybeUnserialize('a:1:{s:5:"Färg";i:1;}')).toEqual({
      ok: true,
      serialized: true,
      value: { Färg: 1 },
    });
    // Character length instead of byte length (a broken search-replace) is reported, not thrown.
    const bad = maybeUnserialize('s:4:"Färg";');
    expect(bad).toMatchObject({ ok: false, serialized: true });
  });
});

describe('real serialized values from the Namez export', () => {
  const pm = parseTsv(
    readFileSync(
      join(__dirname, '__fixtures__', 'namez-slice', 'postmeta.tsv'),
      'utf8',
    ),
    {
      columns: BUNDLE_TABLES.postmeta.columns,
    },
  ).rows;
  const meta = (post: string, key: string) =>
    pm.find((r) => r.post_id === post && r.meta_key === key)!
      .meta_value as string;

  it('decodes 2826 _product_attributes', () => {
    const v = phpUnserialize(meta('2826', '_product_attributes')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(v)).toEqual([
      'pa_farg',
      'pa_gravyr-teckensnitt',
      'pa_antal-inskriptioner',
    ]);
    expect(v['pa_antal-inskriptioner']).toEqual({
      name: 'pa_antal-inskriptioner',
      value: '',
      position: 2,
      is_visible: 1,
      is_variation: 1,
      is_taxonomy: 1,
    });
  });

  it('decodes 4414 _product_meta_id and rank_math_robots', () => {
    expect(phpUnserialize(meta('4414', '_product_meta_id'))).toEqual([2]);
    expect(phpUnserialize(meta('4275', 'rank_math_robots'))).toEqual(['index']);
  });

  it('decodes every serialized meta value in the slice', () => {
    const failures = pm.filter(
      (r) =>
        isPhpSerialized(r.meta_value) && !maybeUnserialize(r.meta_value).ok,
    );
    expect(failures.map((r) => `${r.post_id}/${r.meta_key}`)).toEqual([]);
    expect(
      pm.filter((r) => isPhpSerialized(r.meta_value)).length,
    ).toBeGreaterThan(20);
  });
});
