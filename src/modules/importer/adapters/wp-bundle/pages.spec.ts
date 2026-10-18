import { join } from 'path';
import { DirectoryBundleReader } from '../bundle-reader';
import { buildPages, pagePathSettings, postPath } from './pages';
import { WpBundleAdapter } from './wp-bundle.adapter';
import { loadWpTables, MetaBag, type WpPost, type WpTables } from './wp-tables';
import type { NIssue } from '../../model/normalized';

/**
 * M5 B17: pages / posts of a bundle v1 → `catalog.pages` with the old URL
 * paths computed the way WordPress builds them.
 */
const FIXTURE = join(__dirname, '__fixtures__', 'wp-export-v1');
const SOURCE = {
  kind: 'WP_BUNDLE' as const,
  site_host: 'shop.example',
  host_aliases: [],
  settings: {},
};

describe('wp-bundle pages (M5 B17)', () => {
  let tables: WpTables;
  beforeAll(async () => {
    tables = await loadWpTables(new DirectoryBundleReader(FIXTURE));
  });

  it('builds pages and posts from the v1 fixture with nested paths and Rank Math SEO', async () => {
    const catalog = await new WpBundleAdapter().load({
      bundle: new DirectoryBundleReader(FIXTURE),
      source: SOURCE,
    });
    expect(catalog.pages).toHaveLength(3);
    const [om, kontakt, post] = catalog.pages!;
    expect(om).toMatchObject({
      ref: 'woo:shop.example:page:600',
      source_id: '600',
      kind: 'page',
      slug: 'om-oss',
      path: '/om-oss/',
      title: 'Om oss',
      status: 'publish',
      parent_ref: null,
      published_at: '2026-05-02 09:00:00',
      seo: { meta_title: 'Om oss %sep% %sitename%', noindex: false },
    });
    // Raw HTML stays raw here (sanitized in apply through the sanitizer seam).
    expect(om.html).toContain('<script>');
    expect(kontakt).toMatchObject({
      ref: 'woo:shop.example:page:601',
      kind: 'page',
      path: '/om-oss/kontakt/',
      parent_ref: 'woo:shop.example:page:600',
      seo: { noindex: true },
    });
    // permalink_structure is `/%postname%/` in the fixture.
    expect(post).toMatchObject({
      ref: 'woo:shop.example:post:700',
      kind: 'post',
      slug: 'nyheter-varen',
      path: '/nyheter-varen/',
      excerpt: 'Vårnyheter',
      seo: { meta_desc: 'Vårens nyheter', noindex: false },
    });
    // Products, templates and categories are untouched by the content rows.
    expect(catalog.products.map((p) => p.source_id)).toEqual([
      '100',
      '200',
      '210',
    ]);
    expect(catalog.categories.map((c) => c.slug)).toEqual(['muggar']);
    expect(catalog.tags).toEqual([]);
  });

  it('resolves the permalink tokens of a post (dates, category path, id)', () => {
    const post = tables.posts.get(700)!;
    const settings = (structure: string) => ({
      ...pagePathSettings(tables),
      permalink_structure: structure,
    });
    expect(
      postPath(tables, post, settings('/%year%/%monthnum%/%day%/%postname%/')),
    ).toBe('/2026/05/03/nyheter-varen/');
    expect(postPath(tables, post, settings('/blog/%postname%/'))).toBe(
      '/blog/nyheter-varen/',
    );
    expect(postPath(tables, post, settings('/%category%/%postname%/'))).toBe(
      '/nyheter/nyheter-varen/',
    );
    expect(postPath(tables, post, settings('/archives/%post_id%'))).toBe(
      '/archives/700',
    );
    // Plain links: the shortlink is the URL.
    expect(postPath(tables, post, settings(''))).toBe('/?p=700');
    // Authors are never exported: the path cannot be computed.
    expect(
      postPath(tables, post, settings('/%author%/%postname%/')),
    ).toBeNull();
    // A post without a category falls back to WordPress' default slug.
    const orphan: WpPost = { ...post, id: 701 };
    expect(postPath(tables, orphan, settings('/%category%/%postname%/'))).toBe(
      '/uncategorized/nyheter-varen/',
    );
  });

  it('maps the static front page to `/`, warns on unresolvable post paths and ignores other post types', () => {
    const options = new Map(tables.options);
    options.set('show_on_front', 'page');
    options.set('page_on_front', '600');
    options.set('permalink_structure', '/%author%/%postname%/');
    const t: WpTables = { ...tables, options };
    const issues: NIssue[] = [];
    const pages = buildPages(t, (kind, id) => `woo:x:${kind}:${id}`, issues);
    expect(pages.map((p) => [p.ref, p.path])).toEqual([
      ['woo:x:page:600', '/'],
      ['woo:x:page:601', '/om-oss/kontakt/'],
    ]);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'W_CONTENT_PATH_UNKNOWN',
        external_ref: 'woo:x:post:700',
      }),
    ]);
  });

  it('is absent for a bundle without content post types (legacy export)', () => {
    const posts = new Map(
      [...tables.posts].filter(
        ([, p]) => p.type !== 'page' && p.type !== 'post',
      ),
    );
    const t: WpTables = {
      ...tables,
      posts,
      postmeta: new Map<number, MetaBag>(),
    };
    expect(buildPages(t, (kind, id) => `woo:x:${kind}:${id}`, [])).toEqual([]);
  });
});
