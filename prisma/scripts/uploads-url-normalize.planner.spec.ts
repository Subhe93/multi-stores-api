import {
  PRIVATE_KEY_COLUMNS,
  UPLOAD_REF_COLUMNS,
  columnLabel,
  fingerprint,
  isNoop,
  newColumnStats,
  parseArgs,
  planRow,
  referencedMediaKeys,
  referencedPrivateKeys,
  renderPlan,
  resolveHosts,
  type Plan,
  type UploadRefColumn,
} from './uploads-url-normalize.planner';

const HOSTS = ['ms-api.shopsdoor.com', 'localhost:3001'];
const col = (model: string, column: string): UploadRefColumn =>
  UPLOAD_REF_COLUMNS.find((c) => c.model === model && c.column === column)!;

describe('column inventory', () => {
  it('covers every INVENTORY §2 column', () => {
    const labels = UPLOAD_REF_COLUMNS.map(columnLabel);
    for (const expected of [
      'productImage.url',
      'customProductImage.url',
      'productVideo.url',
      'productVideo.poster_url',
      'provider.logo_url',
      'creator.avatar_url',
      'creator.cover_url',
      'user.avatar_url',
      'creatorCategory.thumbnail_url',
      'category.icon',
      'orderCustomFieldValue.file_url',
      'orderCustomFieldValue.value',
      'customProductFieldValue.file_url',
      'orderItem.customer_design_url',
      'cartItem.custom_fields',
      'page.seo',
      'pageSection.settings',
      'pageSectionTranslation.content',
      'pageBlock.settings',
      'pageBlockTranslation.content',
      'pageVersion.snapshot',
      'customFieldTranslation.help_image_url',
      'productCustomField.ui',
      'personalizationFieldTemplate.definition',
      'store.theme_customizations',
      'store.theme_config',
    ]) {
      expect(labels).toContain(expected);
    }
    expect(new Set(labels).size).toBe(labels.length);
    expect(PRIVATE_KEY_COLUMNS.map(columnLabel)).toContain('invoice.pdf_path');
  });
});

describe('planRow (url columns)', () => {
  it('rewrites a whole-value absolute URL of a known host', () => {
    const c = col('productImage', 'url');
    const stats = newColumnStats(c);
    const ch = planRow(
      c,
      'r1',
      'https://ms-api.shopsdoor.com/uploads/products/a.webp',
      HOSTS,
      stats,
    );
    expect(ch).toEqual({
      model: 'productImage',
      column: 'url',
      id: 'r1',
      next: '/uploads/products/a.webp',
      occurrences: 1,
    });
    expect(stats).toMatchObject({
      rows_scanned: 1,
      rows_to_change: 1,
      occurrences: 1,
    });
  });

  it('product videos: relativises an absolute file URL, never touches YouTube/Vimeo URLs', () => {
    const c = col('productVideo', 'url');
    const stats = newColumnStats(c);
    expect(
      planRow(
        c,
        'v1',
        'https://ms-api.shopsdoor.com/uploads/products/v.mp4',
        HOSTS,
        stats,
      ),
    ).toMatchObject({ next: '/uploads/products/v.mp4' });
    expect(
      planRow(
        c,
        'v2',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        HOSTS,
        stats,
      ),
    ).toBeNull();
    expect(
      planRow(c, 'v3', 'https://vimeo.com/76979871', HOSTS, stats),
    ).toBeNull();
    expect(
      referencedMediaKeys(
        col('productVideo', 'poster_url'),
        '/uploads/products/p.webp',
      ),
    ).toEqual(['uploads/products/p.webp']);
    expect(
      referencedMediaKeys(c, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toEqual([]);
  });

  it('leaves relative values, nulls, free text and foreign hosts alone', () => {
    const c = col('orderCustomFieldValue', 'value');
    const stats = newColumnStats(c);
    expect(
      planRow(c, 'a', '/uploads/customer-previews/x.webp', HOSTS, stats),
    ).toBeNull();
    expect(planRow(c, 'b', null, HOSTS, stats)).toBeNull();
    expect(planRow(c, 'c', 'Happy birthday Lina', HOSTS, stats)).toBeNull();
    expect(
      planRow(
        c,
        'd',
        'see https://ms-api.shopsdoor.com/uploads/x/y.webp please',
        HOSTS,
        stats,
      ),
    ).toBeNull(); // not a whole-value URL: free text stays as typed
    expect(
      planRow(c, 'e', 'https://cdn.foreign.com/uploads/x/y.webp', HOSTS, stats),
    ).toBeNull();
    expect(stats.rows_scanned).toBe(5);
    expect(stats.rows_to_change).toBe(0);
    expect(stats.foreign_hosts).toEqual({ 'cdn.foreign.com': 1 });
  });
});

describe('planRow (json columns)', () => {
  it('rewrites nested and embedded URLs and counts occurrences', () => {
    const c = col('pageSectionTranslation', 'content');
    const stats = newColumnStats(c);
    const value = {
      hero: {
        image: 'https://ms-api.shopsdoor.com/uploads/store-hero/h.webp',
        alt: 'x',
      },
      html: '<img src="http://localhost:3001/uploads/page-blocks/a.webp"><img src="/uploads/page-blocks/b.webp">',
      items: [{ src: 'https://other.io/uploads/z.webp' }],
    };
    const ch = planRow(c, 'p1', value, HOSTS, stats);
    expect(ch?.occurrences).toBe(2);
    expect(ch?.next).toEqual({
      hero: { image: '/uploads/store-hero/h.webp', alt: 'x' },
      html: '<img src="/uploads/page-blocks/a.webp"><img src="/uploads/page-blocks/b.webp">',
      items: [{ src: 'https://other.io/uploads/z.webp' }],
    });
    expect(stats.foreign_hosts).toEqual({ 'other.io': 1 });
  });

  it('returns null for a JSON document without upload URLs', () => {
    const c = col('store', 'theme_customizations');
    const stats = newColumnStats(c);
    expect(
      planRow(c, 's1', { palette: { primary: '#000' } }, HOSTS, stats),
    ).toBeNull();
    expect(
      planRow(c, 's2', { logo: '/uploads/logos/l.svg' }, HOSTS, stats),
    ).toBeNull();
  });
});

describe('fingerprint', () => {
  const change = (id: string, next: unknown) => ({
    model: 'productImage',
    column: 'url',
    id,
    next,
    occurrences: 1,
  });
  const plan = (changes: Plan['changes']): Plan => ({
    hosts: HOSTS,
    columns: [],
    changes,
  });

  it('is order-independent and 16 hex chars', () => {
    const a = fingerprint(
      plan([change('1', '/uploads/a'), change('2', '/uploads/b')]),
    );
    const b = fingerprint(
      plan([change('2', '/uploads/b'), change('1', '/uploads/a')]),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a row, a value or the host list changes', () => {
    const base = fingerprint(plan([change('1', '/uploads/a')]));
    expect(fingerprint(plan([change('1', '/uploads/c')]))).not.toBe(base);
    expect(
      fingerprint(plan([change('1', '/uploads/a'), change('3', '/uploads/a')])),
    ).not.toBe(base);
    expect(
      fingerprint({
        hosts: ['x.com'],
        columns: [],
        changes: [change('1', '/uploads/a')],
      }),
    ).not.toBe(base);
  });

  it('covers JSON values', () => {
    const a = fingerprint(plan([change('1', { x: '/uploads/a' })]));
    const b = fingerprint(plan([change('1', { x: '/uploads/b' })]));
    expect(a).not.toBe(b);
  });
});

describe('renderPlan', () => {
  it('prints counts per column, never a value', () => {
    const c = col('creator', 'avatar_url');
    const stats = newColumnStats(c);
    const ch = planRow(
      c,
      'cr-1',
      'https://ms-api.shopsdoor.com/uploads/avatars/secret-name.webp',
      HOSTS,
      stats,
    )!;
    const plan: Plan = { hosts: HOSTS, columns: [stats], changes: [ch] };
    const out = renderPlan(plan, 'dry-run');
    expect(out).toContain('creator.avatar_url');
    expect(out).toContain('rows to update: 1');
    expect(out).not.toContain('secret-name');
    expect(out).toContain(`fingerprint: ${fingerprint(plan)}`);
    expect(isNoop(plan)).toBe(false);
  });
});

describe('resolveHosts', () => {
  it('merges flags, env and the default', () => {
    expect(
      resolveHosts(['A.example.com', 'https://b.example.com/'], {
        PUBLIC_API_URL: 'https://ms-api.shopsdoor.com',
        API_PUBLIC_ORIGINS:
          'https://api2.shopsdoor.com, https://ms-api.shopsdoor.com',
      }),
    ).toEqual([
      'a.example.com',
      'api2.shopsdoor.com',
      'b.example.com',
      'localhost:3001',
      'ms-api.shopsdoor.com',
    ]);
  });
});

describe('referenced keys', () => {
  it('extracts media keys from url and json columns, any host', () => {
    expect(
      referencedMediaKeys(
        col('productImage', 'url'),
        'https://old.host/uploads/products/a.webp',
      ),
    ).toEqual(['uploads/products/a.webp']);
    expect(
      referencedMediaKeys(col('page', 'seo'), {
        og_image: '/uploads/page-seo/o.webp',
        robots: 'index',
      }),
    ).toEqual(['uploads/page-seo/o.webp']);
    expect(referencedMediaKeys(col('productImage', 'url'), null)).toEqual([]);
  });

  it('extracts private keys and print file keys', () => {
    const key = PRIVATE_KEY_COLUMNS.find((c) => c.column === 'original_key')!;
    const pf = PRIVATE_KEY_COLUMNS.find((c) => c.column === 'print_files')!;
    expect(
      referencedPrivateKeys(key, 'customer-uploads/2026/11/x.jpg'),
    ).toEqual(['customer-uploads/2026/11/x.jpg']);
    expect(
      referencedPrivateKeys(pf, [
        { key: 'designer/s/2026/print/a.png' },
        { nokey: 1 },
      ]),
    ).toEqual(['designer/s/2026/print/a.png']);
    expect(referencedPrivateKeys(pf, 'not an array')).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('defaults to dry-run and requires a fingerprint for --apply', () => {
    expect(parseArgs([])).toMatchObject({
      mode: 'dry-run',
      hosts: [],
      batch: 1000,
    });
    expect(
      parseArgs(['--hosts=a.com,b.com', '--hosts', 'c.com']).hosts,
    ).toEqual(['a.com', 'b.com', 'c.com']);
    expect(() => parseArgs(['--apply'])).toThrow(/--fingerprint/);
    expect(parseArgs(['--apply', '--fingerprint=ABCD'])).toMatchObject({
      mode: 'apply',
      fingerprint: 'abcd',
    });
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--only=nope.x'])).toThrow(/unknown column/);
  });
});
