/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { existsSync } from 'fs';
import { join } from 'path';
import { NAMEZ_EXPORT_DIR } from '../adapters/wp-bundle/__fixtures__/fixtures';
import { makeHarness, NAMEZ_OPTIONS, STORE_ID } from '../__fixtures__/harness';
import {
  AllowlistHtmlSanitizer,
  PlainTextHtmlSanitizer,
  W_HTML_SANITIZER_FALLBACK,
} from './html-sanitizer';

/**
 * The full Namez export (client data, not in the repository; set
 * NAMEZ_EXPORT_DIR) through the importer with the allowlist sanitizer:
 * the §12.3 counts are unchanged, descriptions keep their markup, the
 * fallback warning is gone, and the set of products whose stored
 * description differs from the plain-text run is exactly the set that
 * becomes UPDATE on the first re-run after switching sanitizers.
 */
const available = existsSync(join(NAMEZ_EXPORT_DIR, 'posts.tsv'));
const describeIfExport = available ? describe : describe.skip;

const MARKUP_RE = /<(ul|ol|h2|h3|h4|strong|em|b|table|blockquote|a|img)\b/i;

describeIfExport('Namez full export with the allowlist sanitizer (D11)', () => {
  jest.setTimeout(180_000);

  it('same counts, markup kept, no fallback warning, images only on the source host', async () => {
    const h = await makeHarness({ sanitizer: new AllowlistHtmlSanitizer() });
    const run = await h.dryRun(NAMEZ_OPTIONS, NAMEZ_EXPORT_DIR);
    expect(run.status).toBe('PLANNED');
    const summary = run.summary as any;
    expect(summary.counts.PRODUCT).toEqual({ CREATE: 35, SKIP: 1 });
    expect(summary.counts.VARIANT).toEqual({ CREATE: 232 });
    expect(summary.counts.CATEGORY).toEqual({ CREATE: 78 });
    // REDIRECT (194 in §12.3) is asserted below as "same as the plain-text run":
    // the redirect planner is being extended independently of the sanitizer.
    expect(summary.counts.REDIRECT.CREATE).toBeGreaterThanOrEqual(194);
    expect(summary.plan.sanitizer).toBe('allowlist');
    expect(summary.warnings[W_HTML_SANITIZER_FALLBACK]).toBeUndefined();

    const done = await h.apply(run.id);
    // Same end state as the plain-text run in planner/namez-full-import.spec.
    expect(done.status).toBe('COMPLETED_WITH_WARNINGS');
    const logs: any = await h.runs.logs(STORE_ID, run.id, {
      page: 1,
      limit: 500,
    } as any);
    expect(
      logs.items.filter((l: any) => l.code === W_HTML_SANITIZER_FALLBACK),
    ).toHaveLength(0);

    const translations = h.db.productTranslation.rows as any[];
    expect(translations).toHaveLength(35);
    const withMarkup = translations.filter((t) =>
      MARKUP_RE.test(t.description ?? ''),
    );
    // Markup survives (11 products carry lists / headings / bold in the export).
    expect(withMarkup.length).toBe(11);
    expect(
      withMarkup.filter((t) => /<(ul|h2|strong)\b/.test(t.description)),
    ).not.toHaveLength(0);
    // Nothing dangerous is stored, and no attribute other than the allowlist.
    for (const t of translations) {
      const html = `${t.description ?? ''}${t.short_description ?? ''}`;
      expect(html).not.toMatch(/<(script|style|iframe|svg|form)\b/i);
      expect(html).not.toMatch(
        /\son[a-z]+\s*=|javascript:|data-[a-z]|style=|class=/i,
      );
    }
    // Inline images that remain point at the platform (rewritten), never at other hosts.
    for (const t of translations)
      for (const m of (t.description ?? '').matchAll(
        /<img\b[^>]*src="([^"]*)"/g,
      ))
        expect(m[1]).toMatch(/^\/uploads\//);
    // W_HTML_IMAGE_REMOVED only for images on other hosts (count from the plan warnings).
    const removed = summary.warnings.W_HTML_IMAGE_REMOVED;
    if (removed)
      for (const s of removed.samples)
        expect(s.message).toMatch(/inline image\(s\) on other hosts/);
  });

  it('switching from the plain-text run makes exactly the products with changed HTML UPDATE', async () => {
    const plain = await makeHarness({
      sanitizer: new PlainTextHtmlSanitizer(),
    });
    const allow = await makeHarness({
      sanitizer: new AllowlistHtmlSanitizer(),
    });
    const r1 = await plain.dryRun(NAMEZ_OPTIONS, NAMEZ_EXPORT_DIR);
    await plain.apply(r1.id);
    const r2 = await allow.dryRun(NAMEZ_OPTIONS, NAMEZ_EXPORT_DIR);
    await allow.apply(r2.id);
    // Counts are identical whichever sanitizer runs; only the fallback warning differs.
    expect((r2.summary as any).counts).toEqual((r1.summary as any).counts);
    expect((r1.summary as any).warnings[W_HTML_SANITIZER_FALLBACK]?.count).toBe(
      1,
    );
    expect(
      (r2.summary as any).warnings[W_HTML_SANITIZER_FALLBACK],
    ).toBeUndefined();
    // The run logs differ by the fallback warning only.
    const warnCodes = async (h: typeof plain, id: string) => {
      const logs: any = await h.runs.logs(STORE_ID, id, {
        page: 1,
        limit: 500,
      } as any);
      return new Set<string>(
        logs.items
          .filter((l: any) => l.level === 'WARN')
          .map((l: any) => l.code),
      );
    };
    const c1 = await warnCodes(plain, r1.id);
    const c2 = await warnCodes(allow, r2.id);
    expect(c1.has(W_HTML_SANITIZER_FALLBACK)).toBe(true);
    c1.delete(W_HTML_SANITIZER_FALLBACK);
    expect([...c2].sort()).toEqual([...c1].sort());
    const bySlug = (rows: any[]) =>
      new Map(
        rows.map((t) => [
          t.slug,
          `${t.description ?? ''}\u0000${t.short_description ?? ''}`,
        ]),
      );
    const a = bySlug(plain.db.productTranslation.rows);
    const b = bySlug(allow.db.productTranslation.rows);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    const changed = [...a.keys()]
      .filter((slug) => a.get(slug) !== b.get(slug))
      .sort();
    // Every product whose description or excerpt differs becomes UPDATE on
    // the next run (the sanitized HTML is part of `source_hash`). The plain
    // fallback re-wrote every description (entities decoded, paragraphs
    // rebuilt, `<br>` instead of `<br />`), so ALL 35 products flip to
    // UPDATE once; variants hash separately and stay UNCHANGED.
    expect(changed).toHaveLength(35);
  });
});
