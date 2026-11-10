import {
  OCCASION_PRESET_TEXT,
  occasionPresetText,
} from '../../src/modules/occasion-conversion/occasion-preset';
import {
  buildPlan,
  decideContent,
  fingerprint,
  isNoop,
  isPresetShape,
  OLD_PRESET_HEADINGS,
  parseArgs,
  renderPlan,
  type Plan,
  type PublishedSnapshot,
  type SnapPage,
  type Snapshot,
} from './occasion-headings-fix.planner';

// Occasion headings fix (2026-11-10): old preset headings of existing
// occasion pages → no heading + products subheading, in the draft rows and
// in the published snapshot.

const HTML = '<p>SEO text</p>';

function draftSections(
  over: {
    products?: Record<string, Record<string, unknown>>;
    text?: Record<string, Record<string, unknown>> | null;
  } = {},
): SnapPage['sections'] {
  const products = over.products ?? {
    sv: { heading: 'Våra favoriter', link_label: 'Visa alla' },
    en: { heading: 'Our picks', link_label: 'View all' },
  };
  const text =
    over.text === undefined
      ? {
          sv: { heading: 'Om dessa presenter', html: HTML },
          en: { heading: 'About these gifts', html: HTML },
        }
      : over.text;
  const tr = (m: Record<string, Record<string, unknown>>) =>
    Object.entries(m).map(([locale, content]) => ({ locale, content }));
  const out: SnapPage['sections'] = [
    {
      id: 's-hero',
      section_key: 'hero-banner',
      sort_order: 0,
      translations: tr({ sv: { heading: 'Present till pappa' } }),
    },
    {
      id: 's-products',
      section_key: 'collection-products',
      sort_order: 1,
      translations: tr(products),
    },
  ];
  if (text)
    out.push({
      id: 's-text',
      section_key: 'rich-text',
      sort_order: 2,
      translations: tr(text),
    });
  return out;
}

/** The snapshot as buildPublishSnapshot() freezes the given draft sections. */
function snapshotOf(sections: SnapPage['sections']): PublishedSnapshot {
  return {
    page: { type: 'LANDING', slug: 'pappa', seo: {}, translations: [] },
    sections: sections.map((s) => ({
      id: s.id,
      section_key: s.section_key,
      settings: { x: 1 },
      sort_order: s.sort_order,
      translations: s.translations.map((t) => ({
        locale: t.locale,
        content: { ...t.content },
      })),
    })),
  };
}

function page(over: Partial<SnapPage> = {}): SnapPage {
  const sections = over.sections ?? draftSections();
  return {
    id: over.id ?? 'page-1',
    slug: over.slug === undefined ? 'pappa' : over.slug,
    sections,
    published_version:
      over.published_version === undefined
        ? { id: 'ver-1', snapshot: snapshotOf(sections) }
        : over.published_version,
  };
}

function snap(pages: SnapPage[]): Snapshot {
  return { store: { id: 'store-1', slug: 'namez' }, pages };
}

/** Simulates --apply: the edits land in the draft rows and the snapshot. */
function afterApply(s: Snapshot, plan: Plan): Snapshot {
  return {
    ...s,
    pages: s.pages.map((p) => {
      const planned = plan.pages.find((x) => x.id === p.id);
      if (!planned) return p;
      return {
        ...p,
        sections: p.sections.map((sec) => ({
          ...sec,
          translations: sec.translations.map((t) => {
            const e = planned.translation_edits.find(
              (x) => x.section_id === sec.id && x.locale === t.locale,
            );
            return e ? { ...t, content: e.content_after } : t;
          }),
        })),
        published_version:
          planned.snapshot_edit && p.published_version
            ? {
                ...p.published_version,
                snapshot: planned.snapshot_edit.snapshot_after,
              }
            : p.published_version,
      };
    }),
  };
}

describe('occasion-headings-fix planner', () => {
  it('parses the CLI arguments', () => {
    expect(parseArgs(['--store', 'namez'])).toEqual({
      store: 'namez',
      mode: 'dry-run',
      fingerprint: null,
    });
    expect(
      parseArgs(['--store=namez', '--apply', '--fingerprint=abcd1234']),
    ).toEqual({ store: 'namez', mode: 'apply', fingerprint: 'abcd1234' });
    expect(() => parseArgs([])).toThrow('--store');
    expect(() => parseArgs(['--store', 'x', '--bogus'])).toThrow('Unknown');
  });

  it('old headings exist for every preset locale', () => {
    expect(Object.keys(OLD_PRESET_HEADINGS).sort()).toEqual(
      Object.keys(OCCASION_PRESET_TEXT).sort(),
    );
  });

  it('recognises the preset shape only', () => {
    expect(isPresetShape(['hero-banner', 'collection-products'])).toBe(true);
    expect(
      isPresetShape(['hero-banner', 'collection-products', 'rich-text']),
    ).toBe(true);
    expect(
      isPresetShape([
        'hero-banner',
        'collection-products',
        'rich-text',
        'faq-list',
      ]),
    ).toBe(true);
    expect(isPresetShape(['hero-banner'])).toBe(false);
    expect(isPresetShape(['hero-banner', 'rich-text'])).toBe(false);
    expect(
      isPresetShape(['hero-banner', 'collection-products', 'faq-list']),
    ).toBe(false);
    expect(
      isPresetShape([
        'hero-banner',
        'collection-products',
        'rich-text',
        'faq-list',
        'faq-list',
      ]),
    ).toBe(false);
  });

  it('match: removes both old headings and sets the locale subheading in draft and snapshot', () => {
    const s = snap([page()]);
    const plan = buildPlan(s);
    expect(plan.counts).toMatchObject({
      pages_scanned: 1,
      pages_preset_shaped: 1,
      pages_matched: 1,
      pages_already_converted: 0,
      drafts_without_version: 0,
      snapshots_to_edit: 1,
      snapshots_skipped_shape: 0,
      translations_to_edit: 4,
      per_locale: { sv: 4, en: 4 },
      custom_headings_kept: 0,
      unmapped_locale_kept: 0,
      subheadings_kept: 0,
    });
    expect(plan.skipped_other_shape).toEqual([]);
    const p = plan.pages[0];
    expect(p.translation_edits).toEqual([
      {
        section_id: 's-products',
        section_key: 'collection-products',
        locale: 'sv',
        content_after: {
          subheading: 'Hitta din favorit',
          link_label: 'Visa alla',
        },
      },
      {
        section_id: 's-products',
        section_key: 'collection-products',
        locale: 'en',
        content_after: {
          subheading: occasionPresetText('en').products_subheading,
          link_label: 'View all',
        },
      },
      {
        section_id: 's-text',
        section_key: 'rich-text',
        locale: 'sv',
        content_after: { html: HTML },
      },
      {
        section_id: 's-text',
        section_key: 'rich-text',
        locale: 'en',
        content_after: { html: HTML },
      },
    ]);
    // Snapshot edit: same content edits, everything else carried through.
    const after = p.snapshot_edit!.snapshot_after;
    expect(p.snapshot_edit!.version_id).toBe('ver-1');
    expect(after.page).toEqual(s.pages[0].published_version!.snapshot.page);
    expect(after.sections!.map((x) => x.section_key)).toEqual([
      'hero-banner',
      'collection-products',
      'rich-text',
    ]);
    expect(after.sections![1]).toMatchObject({
      id: 's-products',
      settings: { x: 1 },
      sort_order: 1,
    });
    expect(after.sections![1].translations).toEqual([
      {
        locale: 'sv',
        content: { subheading: 'Hitta din favorit', link_label: 'Visa alla' },
      },
      {
        locale: 'en',
        content: { subheading: 'Find your favourite', link_label: 'View all' },
      },
    ]);
    expect(after.sections![2].translations).toEqual([
      { locale: 'sv', content: { html: HTML } },
      { locale: 'en', content: { html: HTML } },
    ]);
    expect(after.sections![0].translations![0].content).toEqual({
      heading: 'Present till pappa',
    });
    // The input snapshot is not mutated.
    expect(
      s.pages[0].published_version!.snapshot.sections![1].translations![0]
        .content,
    ).toEqual({ heading: 'Våra favoriter', link_label: 'Visa alla' });
    expect(isNoop(plan)).toBe(false);
  });

  it('custom heading kept: an owner-edited heading is never touched', () => {
    const s = snap([
      page({
        sections: draftSections({
          products: {
            sv: { heading: 'Pappas favoriter', link_label: 'Visa alla' },
            en: { heading: 'Our picks', link_label: 'View all' },
          },
          text: {
            sv: { heading: 'Läs mer', html: HTML },
            en: { heading: 'About these gifts', html: HTML },
          },
        }),
      }),
    ]);
    const plan = buildPlan(s);
    expect(plan.counts.pages_matched).toBe(1);
    expect(plan.counts.translations_to_edit).toBe(2);
    expect(plan.counts.per_locale).toEqual({ en: 4 });
    // 2 draft rows + 2 snapshot entries keep their custom heading.
    expect(plan.counts.custom_headings_kept).toBe(4);
    const p = plan.pages[0];
    expect(p.translation_edits.map((e) => e.locale)).toEqual(['en', 'en']);
    expect(p.kept).toEqual(
      expect.arrayContaining([
        {
          where: 'draft',
          section_key: 'collection-products',
          locale: 'sv',
          reason: 'custom_heading',
        },
        {
          where: 'snapshot',
          section_key: 'rich-text',
          locale: 'sv',
          reason: 'custom_heading',
        },
      ]),
    );
    const sv = p.snapshot_edit!.snapshot_after.sections![1].translations![0];
    expect(sv.content).toEqual({
      heading: 'Pappas favoriter',
      link_label: 'Visa alla',
    });
    const text = renderPlan(plan);
    expect(text).toContain('custom heading kept');
    expect(text).not.toContain('Pappas favoriter');
  });

  it('existing subheading kept: the heading goes, the subheading stays', () => {
    const s = snap([
      page({
        sections: draftSections({
          products: {
            sv: {
              heading: 'Våra favoriter',
              subheading: 'Egen rad',
              link_label: 'Visa alla',
            },
          },
          text: null,
        }),
      }),
    ]);
    const plan = buildPlan(s);
    expect(plan.counts.subheadings_kept).toBe(2);
    expect(plan.pages[0].translation_edits).toEqual([
      {
        section_id: 's-products',
        section_key: 'collection-products',
        locale: 'sv',
        content_after: { subheading: 'Egen rad', link_label: 'Visa alla' },
      },
    ]);
    // An empty subheading does not count as existing.
    expect(
      decideContent('collection-products', 'sv', {
        heading: 'Våra favoriter',
        subheading: '  ',
      }),
    ).toEqual({ after: { subheading: 'Hitta din favorit' }, kept: [] });
  });

  it('rules: a heading in an unmapped locale and other section keys are left alone', () => {
    expect(
      decideContent('collection-products', 'xx', { heading: 'Our picks' }),
    ).toEqual({ after: null, kept: ['unmapped_locale'] });
    expect(
      decideContent('rich-text', 'xx', { heading: 'About these gifts' }),
    ).toEqual({ after: null, kept: ['unmapped_locale'] });
    expect(decideContent('faq-list', 'sv', { heading: 'FAQ' })).toEqual({
      after: null,
      kept: [],
    });
    expect(decideContent('hero-banner', 'sv', { heading: 'Pappa' })).toEqual({
      after: null,
      kept: [],
    });
    expect(decideContent('rich-text', 'sv', { html: HTML })).toEqual({
      after: null,
      kept: [],
    });
    expect(
      decideContent('rich-text', 'ar', {
        heading: 'عن هذه الهدايا',
        html: HTML,
      }),
    ).toEqual({ after: { html: HTML }, kept: [] });
  });

  it('already converted: a second run after apply plans nothing', () => {
    const s = snap([page()]);
    const plan = buildPlan(s);
    const again = buildPlan(afterApply(s, plan));
    expect(isNoop(again)).toBe(true);
    expect(again.counts).toMatchObject({
      pages_scanned: 1,
      pages_preset_shaped: 1,
      pages_matched: 0,
      pages_already_converted: 1,
      translations_to_edit: 0,
      snapshots_to_edit: 0,
    });
    expect(fingerprint(again)).not.toBe(fingerprint(plan));
    expect(fingerprint(buildPlan(s))).toBe(fingerprint(plan));
  });

  it('unpublished draft: translation edits only', () => {
    const plan = buildPlan(snap([page({ published_version: null })]));
    expect(plan.counts).toMatchObject({
      pages_matched: 1,
      drafts_without_version: 1,
      snapshots_to_edit: 0,
      translations_to_edit: 4,
    });
    expect(plan.pages[0].snapshot_edit).toBeNull();
    expect(renderPlan(plan)).toContain('no published version');
  });

  it('snapshot with another shape is skipped while the draft is edited', () => {
    const sections = draftSections();
    const other = snapshotOf(sections);
    other.sections = other.sections!.slice(0, 1);
    const plan = buildPlan(
      snap([
        page({ sections, published_version: { id: 'v', snapshot: other } }),
      ]),
    );
    expect(plan.counts.snapshots_skipped_shape).toBe(1);
    expect(plan.counts.translations_to_edit).toBe(4);
    expect(plan.pages[0].snapshot_edit).toBeNull();
    expect(plan.pages[0].snapshot_shape_mismatch).toBe(true);
  });

  it('skips and lists pages that are not occasion-shaped, even with the old heading', () => {
    const sections = draftSections();
    sections.push({
      id: 's-extra',
      section_key: 'image-text',
      sort_order: 3,
      translations: [],
    });
    const plan = buildPlan(snap([page({ sections, slug: 'mamma' })]));
    expect(plan.counts).toMatchObject({
      pages_scanned: 1,
      pages_preset_shaped: 0,
      pages_matched: 0,
    });
    expect(plan.skipped_other_shape).toEqual([
      {
        id: 'page-1',
        slug: 'mamma',
        keys: ['hero-banner', 'collection-products', 'rich-text', 'image-text'],
      },
    ]);
    expect(renderPlan(plan)).toContain('/mamma');
    expect(renderPlan(plan)).toContain('Skipped (other shape): 1');
    expect(isNoop(plan)).toBe(true);
  });

  it('unmapped locale: the heading is kept and reported, the mapped locales still convert', () => {
    const plan = buildPlan(
      snap([
        page({
          sections: draftSections({
            products: {
              sv: { heading: 'Våra favoriter' },
              xx: { heading: 'Our picks' },
            },
            text: null,
          }),
        }),
      ]),
    );
    expect(plan.counts.pages_matched).toBe(1);
    expect(plan.counts.unmapped_locale_kept).toBe(2);
    expect(plan.counts.custom_headings_kept).toBe(0);
    expect(plan.counts.per_locale).toEqual({ sv: 2 });
    expect(renderPlan(plan)).toContain('heading in an unmapped locale kept');
  });

  it('four-section page with faq-list converts and keeps the faq block untouched', () => {
    const sections = draftSections();
    sections.push({
      id: 's-faq',
      section_key: 'faq-list',
      sort_order: 3,
      translations: [{ locale: 'sv', content: { heading: 'Vanliga frågor' } }],
    });
    const plan = buildPlan(snap([page({ sections })]));
    expect(plan.counts.pages_matched).toBe(1);
    expect(plan.counts.translations_to_edit).toBe(4);
    const after = plan.pages[0].snapshot_edit!.snapshot_after;
    expect(after.sections![3].translations![0].content).toEqual({
      heading: 'Vanliga frågor',
    });
  });

  it('two-section page (no rich-text) converts the products block only', () => {
    const plan = buildPlan(
      snap([page({ sections: draftSections({ text: null }) })]),
    );
    expect(plan.counts.translations_to_edit).toBe(2);
    expect(plan.counts.snapshots_to_edit).toBe(1);
    expect(
      plan.pages[0].snapshot_edit!.snapshot_after.sections!.map(
        (x) => x.section_key,
      ),
    ).toEqual(['hero-banner', 'collection-products']);
  });
});
