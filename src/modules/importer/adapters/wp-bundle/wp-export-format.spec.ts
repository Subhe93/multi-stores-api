import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { DirectoryBundleReader } from '../bundle-reader';
import {
  BUNDLE_FILE_ALLOWLIST,
  BUNDLE_TABLES,
  BundleTableName,
  TableSpec,
  OPTION_ALLOWLIST,
  RANK_MATH_GENERAL_ALLOWED_KEYS,
  SHIPPING_METHOD_OPTION_RE,
} from './bundle-schema';
import { WpBundleAdapter } from './wp-bundle.adapter';
import { loadWpTables, WpTables } from './wp-tables';
import type { NormalizedCatalog } from '../../model/normalized';

/**
 * Format parity between tools/importer/wp-export.sh (M4.4 WP-F) and the
 * bundle reader. The fixture `__fixtures__/wp-export-v1/` is byte-for-byte
 * what the script writes for a small store (tools/importer/test/
 * wp-export.test.sh runs the script against a fake WP-CLI and compares its
 * output with these same files).
 */
const FIXTURE = join(__dirname, '__fixtures__', 'wp-export-v1');
const SCRIPT = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'tools',
  'importer',
  'wp-export.sh',
);
const script = readFileSync(SCRIPT, 'utf8');

/** Items of a bash array `NAME=( ... )` in the script (one word per line). */
function bashArray(name: string): string[] {
  const m = new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, 'm').exec(script);
  if (!m) throw new Error(`array ${name} not found in wp-export.sh`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** `wpx_emit_table FILE "cols"` calls → file → column lists (terms has two forms). */
function emittedTables(): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  const re = /wpx_emit_table ([a-z_]+\.tsv)\s+(?:\\\n\s*)?"([^"$]+)"/g;
  for (const m of script.matchAll(re)) {
    const list = out.get(m[1]) ?? [];
    list.push(m[2].trim().split(/\s+/));
    out.set(m[1], list);
  }
  return out;
}

const specByFile = new Map<string, TableSpec>(
  (Object.keys(BUNDLE_TABLES) as BundleTableName[]).map((k) => [
    BUNDLE_TABLES[k].file,
    BUNDLE_TABLES[k],
  ]),
);

describe('wp-export.sh ↔ bundle-schema parity', () => {
  it('only knows the files of the bundle allowlist', () => {
    expect([...bashArray('WPX_BUNDLE_FILES')].sort()).toEqual(
      [...BUNDLE_FILE_ALLOWLIST].sort(),
    );
  });

  it('exports only allowlisted options', () => {
    const opts = bashArray('WPX_OPTIONS');
    expect(opts.length).toBeGreaterThan(10);
    for (const o of opts) expect(OPTION_ALLOWLIST).toContain(o);
    // The two Rank Math options with personal data are filtered by key instead.
    expect(opts).not.toContain('rank-math-options-general');
    expect(opts).not.toContain('rank-math-options-titles');
    // Every allowlisted option is either exported as-is or filtered.
    for (const o of OPTION_ALLOWLIST)
      expect([
        ...opts,
        'rank-math-options-general',
        'rank-math-options-titles',
      ]).toContain(o);
  });

  it('keeps the same Rank Math general sub-keys as the parser', () => {
    expect(bashArray('WPX_RANK_MATH_GENERAL_KEYS')).toEqual([
      ...RANK_MATH_GENERAL_ALLOWED_KEYS,
    ]);
  });

  it('writes every v1 table with the column order of the schema', () => {
    const emitted = emittedTables();
    for (const [file, lists] of emitted) {
      const spec = specByFile.get(file);
      expect(spec).toBeDefined();
      if (!spec || spec.positional) continue;
      for (const cols of lists) {
        const min = spec.minColumns ?? spec.columns.length;
        expect(cols.length).toBeGreaterThanOrEqual(min);
        expect(cols).toEqual(spec.columns.slice(0, cols.length));
      }
    }
    // terms: the dynamic form adds term_order when the column exists.
    expect(script).toContain('term_cols="$term_cols term_order"');
    // Every non-positional table of the schema is produced.
    for (const spec of specByFile.values())
      if (!spec.positional)
        expect(emitted.has(spec.file) || spec.file === 'terms.tsv').toBe(true);
  });

  it('has a parenthesised WHERE everywhere and never selects *', () => {
    expect(script).not.toMatch(/SELECT \*/);
    const code = script
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const wheres = code.match(/WHERE[^\n]*/g) ?? [];
    expect(wheres.length).toBeGreaterThan(10);
    for (const w of wheres) expect(w).toMatch(/^WHERE \(/);
  });

  it('never names user, order, session or API-key tables', () => {
    expect(script).not.toMatch(
      /\}(users|usermeta|comments|commentmeta|wc_orders|woocommerce_order_items|woocommerce_sessions|woocommerce_api_keys|wc_customer_lookup)\b/,
    );
  });

  it('derives method-instance option names from the methods table only', () => {
    expect(
      SHIPPING_METHOD_OPTION_RE.test('woocommerce_flat_rate_3_settings'),
    ).toBe(true);
    expect(script).toContain(
      "CONCAT('woocommerce_', zm.method_id, '_', zm.instance_id, '_settings')",
    );
    expect(script).not.toMatch(/LIKE 'woocommerce/);
  });

  /** Value of a single-quoted shell variable `NAME='...'` in the script. */
  function shellVar(name: string): string {
    const m = new RegExp(`^${name}='([^']*)'$`, 'm').exec(script);
    if (!m) throw new Error(`variable ${name} not found in wp-export.sh`);
    return m[1];
  }

  it('self-check knows licence keys, purchase codes, tokens and webhooks', () => {
    const re = new RegExp(shellVar('WPX_SECRET_KEY_RE'), 'i');
    for (const s of [
      'license_key',
      'licence_key',
      '_envato_purchase_code',
      'purchasecode',
      '_sync_token',
      'webhook_url',
    ])
      expect(re.test(s)).toBe(true);
  });

  it('scans postmeta/termmeta for e-mails outside the product content keys', () => {
    expect(script).toMatch(
      /\[ "\$base" = postmeta\.tsv \] \|\| \[ "\$base" = termmeta\.tsv \]/,
    );
    const content = new RegExp(shellVar('WPX_CONTENT_META_KEY_RE'));
    // Content keys the adapter reads as shop texts are skipped ...
    for (const k of [
      'rank_math_description',
      'rank_math_title',
      '_variation_description',
      'product_delivery',
      'description',
    ])
      expect(content.test(k)).toBe(true);
    // ... settings-like keys are checked.
    for (const k of ['_note', 'owner_contact', '_sync_token', '_price'])
      expect(content.test(k)).toBe(false);
  });

  it('drops image_meta from _wp_attachment_metadata right after the attachments export', () => {
    expect(script).toMatch(
      /ORDER BY a\.ID"\n(?:\s*#[^\n]*\n)*\s*wpx_strip_image_meta "\$WPX_OUT\/attachments\.tsv"/,
    );
    expect(script).toContain('unset($v["image_meta"])');
    const att = readFileSync(join(FIXTURE, 'attachments.tsv'), 'utf8');
    expect(att).not.toContain('image_meta');
  });
});

describe('wp-export v1 fixture → BundleReader → WpBundleAdapter', () => {
  let tables: WpTables;
  let catalog: NormalizedCatalog;
  const source = {
    kind: 'WP_BUNDLE' as const,
    site_host: 'shop.example',
    host_aliases: [],
    settings: {},
  };

  beforeAll(async () => {
    tables = await loadWpTables(new DirectoryBundleReader(FIXTURE));
    catalog = await new WpBundleAdapter().load({
      bundle: new DirectoryBundleReader(FIXTURE),
      source,
    });
  });

  it('every fixture TSV starts with the schema header', () => {
    for (const name of readdirSync(FIXTURE).filter((f) => f.endsWith('.tsv'))) {
      const spec = specByFile.get(name);
      expect(spec).toBeDefined();
      const header = readFileSync(join(FIXTURE, name), 'utf8')
        .split('\n', 1)[0]
        .split('\t');
      if (!spec!.positional)
        expect(header).toEqual(spec!.columns.slice(0, header.length));
    }
  });

  it('lists every file and reads the manifest as bundle v1', async () => {
    expect(await new DirectoryBundleReader(FIXTURE).list()).toEqual(
      readdirSync(FIXTURE).sort(),
    );
    expect(tables.format_version).toBe(1);
    expect(tables.manifest).toMatchObject({
      format: 'wp-bundle',
      format_version: 1,
      site_url: 'https://shop.example',
      wc_version: '11.2.1',
      locale: 'sv_SE',
      db_prefix: 'wp_',
    });
  });

  it('parses every row without TSV warnings', () => {
    expect(tables.issues.filter((i) => i.code.startsWith('W_TSV'))).toEqual([]);
    expect(tables.posts.size).toBe(6);
    expect(tables.posts.get(100)!.content).toBe(
      '<p>Vit mugg.\nTål diskmaskin\tja.</p>',
    );
    expect(tables.posts.get(200)!.content).toBe('<p>Skylt C:\\temp</p>');
    expect(tables.terms.get(10)!.name).toBe('Muggar &amp; koppar');
    expect(tables.termTaxonomy.get(10)!.description).toBe(
      'Alla muggar\nrad två',
    );
    expect(tables.postmeta.get(100)!.first('rank_math_description')).toBeNull();
  });

  it('reads options, including the filtered Rank Math rows', () => {
    expect(tables.options.get('woocommerce_currency')).toBe('SEK');
    expect(tables.options.has('woocommerce_flat_rate_3_settings')).toBe(true);
    expect(
      JSON.parse(tables.options.get('rank-math-options-general') as string),
    ).toEqual({
      wc_remove_product_base: 'off',
      wc_remove_category_base: 'off',
      strip_category_base: 'off',
      noindex_hidden_products: 'on',
      attachment_redirect_urls: 'on',
    });
    expect(tables.options.get('rank-math-options-titles')).toContain(
      'noindex_empty_taxonomies',
    );
  });

  it('reads PPOM with its JSON field config', () => {
    expect(tables.ppom).toHaveLength(1);
    expect(tables.ppom[0]).toMatchObject({ id: 2, name: 'Välj detaljer' });
    expect(tables.ppom[0].fields?.['1']).toMatchObject({
      type: 'checkbox',
      title: 'Välj detaljer',
      checked: 'Student 2026\r\nNallebjörn',
    });
  });

  it('builds the catalog: meta, products, variations, images', () => {
    expect(catalog.meta).toMatchObject({
      format_version: 1,
      currency: 'SEK',
      prices_include_tax: true,
      locale: 'sv_SE',
      bases: {
        product: 'produkt',
        category: 'product-category',
        tag: 'product-tag',
      },
    });
    expect(catalog.capabilities).toMatchObject({
      shipping: true,
      tax_settings: true,
      original_images: true,
    });
    expect(catalog.products.map((p) => p.source_id)).toEqual([
      '100',
      '200',
      '210',
    ]);
    const mugg = catalog.products[0];
    expect(mugg).toMatchObject({
      type: 'simple',
      slug: 'mugg',
      status: 'publish',
    });
    expect(mugg.price).toMatchObject({ regular: 149, sale: 99, current: 99 });
    expect(mugg.images[0].candidates[0]).toBe(
      'https://shop.example/wp-content/uploads/2026/05/mugg.jpg',
    );
    expect(mugg.images.map((i) => i.ext_id)).toEqual([
      'woo:shop.example:attachment:500',
      'woo:shop.example:attachment:501',
    ]);
    const skylt = catalog.products[1];
    expect(skylt.type).toBe('variable');
    expect(skylt.variations.map((v) => [v.source_id, v.attrs])).toEqual([
      ['201', { pa_farg: 'rod' }],
      ['202', { pa_farg: 'bla' }],
    ]);
  });

  it('builds categories with the term thumbnail', () => {
    const cat = catalog.categories.find((c) => c.slug === 'muggar')!;
    expect(cat.thumbnail?.ext_id).toBe('woo:shop.example:attachment:502');
  });

  it('builds shipping zones with the method-instance settings', () => {
    expect(catalog.shipping?.zones_available).toBe(true);
    const se = catalog.shipping!.zones.find((z) => z.name === 'Sverige')!;
    expect(se.locations).toEqual([{ type: 'country', code: 'SE' }]);
    expect(
      se.methods.map((m) => [m.method_id, m.instance_id, m.settings]),
    ).toEqual([
      [
        'flat_rate',
        '3',
        { title: 'Standard', tax_status: 'taxable', cost: '49' },
      ],
      ['local_pickup', '4', { title: 'Hämta själv', cost: '' }],
      [
        'free_shipping',
        '5',
        { title: 'Fri frakt', requires: 'min_amount', min_amount: '499' },
      ],
    ]);
    expect(catalog.shipping!.classes.map((c) => c.slug)).toEqual([
      'npp-poster',
    ]);
  });
});
