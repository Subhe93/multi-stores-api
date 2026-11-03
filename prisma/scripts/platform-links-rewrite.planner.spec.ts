import {
  LINK_COLUMNS,
  SKIPPED_COLUMNS,
  columnLabel,
  fingerprint,
  isNoop,
  newColumnStats,
  newPlan,
  newRewriteStats,
  parseArgs,
  planRow,
  renderPlan,
  rewriteJson,
  rewriteText,
  type LinkColumn,
  type RewriteRules,
} from './platform-links-rewrite.planner';

const RULES: RewriteRules = {
  apex: { from: 'iwings-digital.com', to: 'shopsdoor.com' },
  dash: { from: 'ms-dash.iwings-digital.com', to: 'app.shopsdoor.com' },
  api: { from: 'ms-api.iwings-digital.com', to: 'api.shopsdoor.com' },
};
const col = (model: string, column: string): LinkColumn =>
  LINK_COLUMNS.find((c) => c.model === model && c.column === column)!;

describe('column inventory', () => {
  it('covers the content columns of the domain-move plan and lists the skips', () => {
    const labels = LINK_COLUMNS.map(columnLabel);
    for (const expected of [
      'menuItem.url',
      'page.seo',
      'pageSection.settings',
      'pageSectionTranslation.content',
      'pageBlock.settings',
      'pageBlockTranslation.content',
      'pageVersion.snapshot',
      'staticPageTranslation.content',
      'legalPage.content',
      'store.theme_customizations',
      'store.theme_config',
      'notificationTemplate.body_html',
      'storeNotificationTemplate.body_html',
      'productTranslation.description',
      'categoryTranslation.description',
      'storeLegalProfile.website',
    ]) {
      expect(labels).toContain(expected);
    }
    expect(new Set(labels).size).toBe(labels.length);
    expect(SKIPPED_COLUMNS).toContain('order.hostname');
    expect(SKIPPED_COLUMNS).toContain('store.custom_domain');
  });
});

describe('rewriteText', () => {
  it('rewrites the apex, its subdomains (www, previews) and keeps scheme/path/query/hash', () => {
    const r = rewriteText(
      [
        'https://iwings-digital.com/products?sort=new#top',
        'https://www.iwings-digital.com/',
        'https://muba.iwings-digital.com/cart',
        'https://muba--eu.iwings-digital.com/en/',
        'http://IWINGS-Digital.com:8443/x',
      ].join(' '),
      RULES,
    );
    expect(r.changed).toBe(5);
    expect(r.text).toBe(
      [
        'https://shopsdoor.com/products?sort=new#top',
        'https://www.shopsdoor.com/',
        'https://muba.shopsdoor.com/cart',
        'https://muba--eu.shopsdoor.com/en/',
        'http://shopsdoor.com:8443/x',
      ].join(' '),
    );
  });

  it('exact dashboard / API hosts win over the apex rule; media URLs are skipped', () => {
    const stats = newRewriteStats();
    const r = rewriteText(
      'a https://ms-dash.iwings-digital.com/creator/products b ' +
        'https://ms-api.iwings-digital.com/api/health c ' +
        'https://ms-api.iwings-digital.com/uploads/products/x.webp d',
      RULES,
      stats,
    );
    expect(r.text).toBe(
      'a https://app.shopsdoor.com/creator/products b ' +
        'https://api.shopsdoor.com/api/health c ' +
        'https://ms-api.iwings-digital.com/uploads/products/x.webp d',
    );
    expect(r.changed).toBe(2);
    expect(stats).toEqual({ apex: 0, dash: 1, api: 1, media_skipped: 1 });
  });

  it('without dash/api rules those hosts fall under the apex rule (labels kept)', () => {
    const r = rewriteText('https://ms-dash.iwings-digital.com/x', {
      ...RULES,
      dash: null,
      api: null,
    });
    expect(r.text).toBe('https://ms-dash.shopsdoor.com/x');
  });

  it('never matches look-alike hosts, other domains or relative links', () => {
    for (const raw of [
      'https://notiwings-digital.com/x',
      'https://iwings-digital.com.evil.io/x',
      'https://iwings-digital.company/x',
      'https://namez.se/products',
      'https://instagram.com/iwings-digital.com',
      '/products?ref=iwings-digital.com',
      'mailto:hi@iwings-digital.com',
      'iwings-digital.com',
      '',
    ]) {
      expect(rewriteText(raw, RULES)).toEqual({ text: raw, changed: 0 });
    }
  });

  it('rewrites href= and src= inside HTML, every occurrence, delimiters kept', () => {
    const html =
      '<p>See <a href="https://muba.iwings-digital.com/om-oss">us</a>, ' +
      "<a href='https://iwings-digital.com/'>home</a> and " +
      '<img src="https://muba.iwings-digital.com/logo.png"> (https://iwings-digital.com/x).</p>';
    const r = rewriteText(html, RULES);
    expect(r.changed).toBe(4);
    expect(r.text).toBe(
      '<p>See <a href="https://muba.shopsdoor.com/om-oss">us</a>, ' +
        "<a href='https://shopsdoor.com/'>home</a> and " +
        '<img src="https://muba.shopsdoor.com/logo.png"> (https://shopsdoor.com/x).</p>',
    );
  });

  it('is idempotent', () => {
    const once = rewriteText('https://muba.iwings-digital.com/a', RULES).text;
    expect(rewriteText(once, RULES)).toEqual({ text: once, changed: 0 });
  });
});

describe('rewriteJson', () => {
  it('deep-walks strings, keeps key order and non-string leaves', () => {
    const value = {
      z: 1,
      a: {
        links: [
          { label: 'Shop', url: 'https://muba.iwings-digital.com/products' },
          { label: 'Ext', url: 'https://namez.se' },
        ],
        html: '<a href="https://iwings-digital.com/x">x</a>',
        n: null,
        b: true,
      },
    };
    const r = rewriteJson(value, RULES);
    expect(r.changed).toBe(2);
    expect(JSON.stringify(r.value)).toBe(
      JSON.stringify({
        z: 1,
        a: {
          links: [
            { label: 'Shop', url: 'https://muba.shopsdoor.com/products' },
            { label: 'Ext', url: 'https://namez.se' },
          ],
          html: '<a href="https://shopsdoor.com/x">x</a>',
          n: null,
          b: true,
        },
      }),
    );
    // Untouched input serialises identically.
    const same = { k: 'plain', arr: [1, 'https://namez.se'] };
    expect(JSON.stringify(rewriteJson(same, RULES).value)).toBe(
      JSON.stringify(same),
    );
  });
});

describe('planRow / plan', () => {
  it('text column: change only when an occurrence was rewritten', () => {
    const plan = newPlan(RULES);
    const c = col('menuItem', 'url');
    const stats = newColumnStats(c);
    expect(planRow(plan, c, 'r0', null, stats)).toBeNull();
    expect(planRow(plan, c, 'r1', '/products', stats)).toBeNull();
    expect(
      planRow(plan, c, 'r2', 'https://muba.iwings-digital.com/products', stats),
    ).toEqual({
      model: 'menuItem',
      column: 'url',
      id: 'r2',
      next: 'https://muba.shopsdoor.com/products',
      occurrences: 1,
    });
    expect(stats).toMatchObject({
      rows_scanned: 3,
      rows_to_change: 1,
      occurrences: 1,
    });
    expect(plan.totals.apex).toBe(1);
  });

  it('json column: per-locale template bodies; media skips are counted', () => {
    const plan = newPlan(RULES);
    const c = col('storeNotificationTemplate', 'body_html');
    const stats = newColumnStats(c);
    const ch = planRow(
      plan,
      c,
      'r1',
      {
        en: '<a href="https://ms-dash.iwings-digital.com/creator/orders">Orders</a>',
        sv: '<img src="https://ms-api.iwings-digital.com/uploads/mail/logo.png">',
      },
      stats,
    );
    expect(ch?.occurrences).toBe(1);
    expect((ch?.next as Record<string, string>).en).toContain(
      'https://app.shopsdoor.com/creator/orders',
    );
    expect((ch?.next as Record<string, string>).sv).toContain(
      'https://ms-api.iwings-digital.com/uploads/mail/logo.png',
    );
    expect(stats.media_skipped).toBe(1);
    expect(plan.totals).toEqual({ apex: 0, dash: 1, api: 0, media_skipped: 1 });
  });

  it('fingerprint depends on the planned set and the rules; report is counts only', () => {
    const plan = newPlan(RULES);
    const c = col('productTranslation', 'description');
    const stats = newColumnStats(c);
    plan.columns.push(stats);
    const secret = 'Visit https://muba.iwings-digital.com/secret-product-name';
    plan.changes.push(planRow(plan, c, 'r1', secret, stats)!);
    const fp = fingerprint(plan);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(isNoop(plan)).toBe(false);

    const other = newPlan({ ...RULES, dash: null });
    other.columns.push(stats);
    other.changes.push(...plan.changes);
    expect(fingerprint(other)).not.toBe(fp);

    const report = renderPlan(plan, 'dry-run');
    expect(report).toContain('productTranslation.description');
    expect(report).toContain('rows to update: 1');
    expect(report).toContain(`fingerprint: ${fp}`);
    expect(report).not.toContain('secret-product-name');
    expect(report).not.toContain('r1');
  });
});

describe('parseArgs', () => {
  const base = ['--from=iwings-digital.com', '--to=shopsdoor.com'];

  it('dry-run by default; host pairs normalised; optional pairs', () => {
    const o = parseArgs([
      ...base,
      '--dash-from',
      'https://MS-Dash.iwings-digital.com/',
      '--dash-to=app.shopsdoor.com',
      '--api-from=ms-api.iwings-digital.com',
      '--api-to=api.shopsdoor.com',
      '--only=menuItem.url',
      '--batch=50',
    ]);
    expect(o.mode).toBe('dry-run');
    expect(o.rules).toEqual(RULES);
    expect(o.only).toEqual(['menuItem.url']);
    expect(o.batch).toBe(50);
    expect(parseArgs(base).rules).toEqual({
      apex: RULES.apex,
      dash: null,
      api: null,
    });
  });

  it('rejects missing / half pairs, same hosts, apply without fingerprint, unknown args', () => {
    expect(() => parseArgs([])).toThrow('--from');
    expect(() => parseArgs(['--from=a.com', '--to=a.com'])).toThrow('same host');
    expect(() => parseArgs([...base, '--dash-from=x.a.com'])).toThrow(
      'together',
    );
    expect(() => parseArgs([...base, '--apply'])).toThrow('--fingerprint');
    expect(() => parseArgs([...base, '--nope'])).toThrow('Unknown argument');
    expect(() => parseArgs([...base, '--only=nope.x'])).toThrow('unknown column');
    expect(() => parseArgs(['--from=not a host', '--to=b.com'])).toThrow(
      'not a hostname',
    );
    expect(
      parseArgs([...base, '--apply', '--fingerprint=ABCD']).fingerprint,
    ).toBe('abcd');
  });
});
