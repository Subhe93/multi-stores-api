import {
  buildPlan,
  buildRestorePlan,
  draftDiff,
  fingerprint,
  isNoop,
  mergeRecordSets,
  pageDiff,
  parseArgs,
  stateFromSnapshot,
  validateRecord,
  type BackupFile,
  type EntityState,
  type PlanOptions,
  type Snapshot,
  type TranslationRecord,
} from './namez-shop-i18n-apply.planner';

// namez.shop translations (2026-11-20): pure merge / plan / restore logic.

const OPTS: PlanOptions = { overwrite: false, publishDraftChanges: false, onlyTypes: [] };

function snapshot(): Snapshot {
  return {
    store: { id: 'store-1', slug: 'namez-se', primary_locale: 'sv' },
    products: {
      p1: {
        id: 'p1',
        translations: [
          { locale: 'sv', title: 'Namnskylt', slug: 'namnskylt', description: '<p>Sv</p>', short_description: null, meta_title: null, meta_desc: null },
          { locale: 'en', title: 'Name sign', slug: 'name-sign', description: '<p>En</p>', short_description: null, meta_title: null, meta_desc: null },
          { locale: 'ar', title: 'لافتة', slug: 'ar-slug', description: '<p>Ar</p>', short_description: null, meta_title: null, meta_desc: null },
        ],
        variant_option_config: [
          { name: 'Välj storlek', style: 'card', values: ['Liten', 'Stor'], valueMeta: { Stor: { label: 'Stor', badge: 'Störst' } } },
        ],
        stories: [
          {
            id: 's1', kind: 'IMAGE', url: '/uploads/a.jpg', poster_url: null, duration_s: null, width: null, height: null,
            name: 'Anna', rating: 5, verified: true, autoplay: false, loop: false,
            translations: [{ locale: 'sv', quote: 'Så fin!', subtitle: null }],
          },
        ],
      },
    },
    custom_fields: {
      f1: {
        id: 'f1',
        product_id: 'p1',
        translations: [
          { locale: 'sv', label: 'Välj', placeholder: null, option_labels: { A: 'A' }, display_label: null, sublabel: null, note: null, help_text: null, help_image_url: null, messages: null },
          { locale: 'en', label: 'Choose', placeholder: null, option_labels: { A: 'Alpha' }, display_label: null, sublabel: null, note: null, help_text: null, help_image_url: null, messages: null },
        ],
      },
    },
    faqs: {},
    collections: {
      c1: { id: 'c1', translations: [{ locale: 'sv', name: 'Smycken', description: null, long_description: null, meta_title: null, meta_desc: null }] },
    },
    pages: {
      pg1: {
        id: 'pg1',
        slug: 'present-till-pappa',
        type: 'LANDING',
        published: true,
        draft_diff: [],
        translations: [{ locale: 'sv', title: 'Present till pappa', meta_title: null, meta_description: null }],
        sections: [
          {
            id: 'sec1',
            section_key: 'collection-products',
            translations: [{ locale: 'sv', content: { subheading: 'Hitta din favorit', link_label: 'Visa alla', link_url: '/collections/pappa', collection_id: 'c1' } }],
          },
        ],
      },
      pg2: {
        id: 'pg2',
        slug: 'om-namez',
        type: 'STATIC',
        published: true,
        draft_diff: ['section rich-text x: translations differ'],
        translations: [{ locale: 'sv', title: 'Om namez', meta_title: null, meta_description: null }],
        sections: [],
      },
    },
    menus: {
      m1: {
        id: 'm1',
        items: [
          {
            id: 'i1', kind: 'CUSTOM', resource_id: null, label: 'För honom', label_i18n: { sv: 'För honom' }, url: '#', open_in_new_tab: false,
            children: [{ id: 'i2', kind: 'PAGE', resource_id: 'pg1', label: 'Pappa', label_i18n: { sv: 'Pappa' }, url: '/present-till-pappa', open_in_new_tab: false, children: [] }],
          },
        ],
      },
    },
    designer_templates: {
      t1: {
        id: 't1',
        current_version_id: 'v1',
        spec: { surfaces: [{ id: 'front', elements: [{ id: 'el1', type: 'text', label: { sv: 'Namn' }, placeholder: { sv: 'Namn' } }] }] },
      },
    },
    designer_addons: {
      p1: { product_id: 'p1', addons: { v: 2, items: [{ key: 'double', type: 'toggle', label: { sv: 'Dubbelsidig', en: 'Double-sided' }, price: 149, enabled: true }] } },
    },
    theme_config: { seo: { metaTitle: 'x' }, translations: { sv: { name: 'English text' } } },
    shipping_methods: { sm1: { id: 'sm1', name: 'Standard', translations: { sv: 'Standardfrakt', en: 'Standard shipping' } } },
  };
}

const rec = (r: Partial<TranslationRecord> & Pick<TranslationRecord, 'type' | 'id' | 'field' | 'locale' | 'value'>) =>
  r as TranslationRecord;

describe('validateRecord', () => {
  it('maps page_translation to page and keeps helper keys', () => {
    const v = validateRecord({ type: 'page_translation', id: 'pg1', field: 'title', locale: 'de', value: 'Startseite', context: 'home' });
    expect(v).toEqual({ ok: true, record: { type: 'page', id: 'pg1', field: 'title', locale: 'de', value: 'Startseite', context: 'home' } });
  });
  it('rejects bad slugs, locales, fields and empty values', () => {
    expect(validateRecord({ type: 'product', id: 'p', field: 'slug', locale: 'de', value: 'Mit Ümlaut' }).ok).toBe(false);
    expect(validateRecord({ type: 'product', id: 'p', field: 'title', locale: 'DE', value: 'x' }).ok).toBe(false);
    expect(validateRecord({ type: 'product', id: 'p', field: 'price', locale: 'de', value: 'x' }).ok).toBe(false);
    expect(validateRecord({ type: 'faq', id: 'f', field: 'answer', locale: 'de', value: '  ' }).ok).toBe(false);
    expect(validateRecord({ type: 'option_card', id: 'p', field: 'label', locale: 'de', value: 'x' }).ok).toBe(false);
    expect(validateRecord({ type: 'page_section', id: 's', field: 'content', locale: 'de', value: {} }).ok).toBe(false);
  });
});

describe('mergeRecordSets', () => {
  const a = { type: 'faq', id: 'f1', field: 'question', locale: 'de', value: 'Frage?' };
  it('collapses identical duplicates and reports conflicting ones', () => {
    const res = mergeRecordSets([
      { source: 'A', records: [a] },
      { source: 'B', records: [{ ...a }, { ...a, locale: 'fr', value: 'Question ?' }] },
      { source: 'C', records: [{ ...a, value: 'Andere Frage?' }] },
    ]);
    expect(res.records).toHaveLength(2);
    expect(res.duplicates).toEqual([{ key: 'faq|f1|||question|de', sources: ['A', 'B'] }]);
    expect(res.conflicts).toEqual([{ key: 'faq|f1|||question|de', sources: ['A', 'C'] }]);
  });
  it('lists invalid records with their source and index', () => {
    const res = mergeRecordSets([{ source: 'A', records: [a, { type: 'nope' }] }]);
    expect(res.invalid).toEqual([{ source: 'A', index: 1, reason: 'unknown type nope' }]);
  });
});

describe('buildPlan', () => {
  it('creates a new locale row and carries every other row over unchanged', () => {
    const snap = snapshot();
    const plan = buildPlan(snap, [
      rec({ type: 'product', id: 'p1', field: 'title', locale: 'de', value: 'Namensschild' }),
      rec({ type: 'product', id: 'p1', field: 'slug', locale: 'de', value: 'namensschild' }),
      rec({ type: 'product', id: 'p1', field: 'description', locale: 'de', value: '<p>De</p>' }),
    ], OPTS);
    expect(plan.changes).toHaveLength(1);
    const after = plan.changes[0].after as Extract<EntityState, { kind: 'product' }>;
    expect(after.translations.map((t) => t.locale)).toEqual(['sv', 'en', 'ar', 'de']);
    expect(after.translations.slice(0, 3)).toEqual(snap.products.p1.translations);
    expect(plan.outcomes.every((o) => o.status === 'set')).toBe(true);
  });

  it('skips an incomplete new row as an error', () => {
    const plan = buildPlan(snapshot(), [rec({ type: 'product', id: 'p1', field: 'title', locale: 'fr', value: 'Plaque' })], OPTS);
    expect(plan.changes).toHaveLength(0);
    expect(plan.outcomes[0]).toMatchObject({ status: 'error', detail: 'new row incomplete' });
  });

  it('treats a differing existing value as a conflict unless --overwrite', () => {
    const r = rec({ type: 'product', id: 'p1', field: 'title', locale: 'en', value: 'Personalised name sign' });
    const same = rec({ type: 'product', id: 'p1', field: 'slug', locale: 'en', value: 'name-sign' });
    const plan = buildPlan(snapshot(), [r, same], OPTS);
    expect(plan.changes).toHaveLength(0);
    expect(plan.outcomes.map((o) => o.status)).toEqual(['conflict', 'unchanged']);
    expect(plan.outcomes[0]).toMatchObject({ current: 'Name sign', value: 'Personalised name sign' });
    const forced = buildPlan(snapshot(), [r], { ...OPTS, overwrite: true });
    expect(forced.outcomes[0].status).toBe('overwrite');
    expect(forced.changes).toHaveLength(1);
  });

  it('copies the sv section content for a new locale and replaces only the given keys', () => {
    const plan = buildPlan(snapshot(), [
      rec({ type: 'page_section', id: 'sec1', field: 'subheading', locale: 'de', value: 'Finde deinen Favoriten' }),
      rec({ type: 'page_section', id: 'sec1', field: 'link_label', locale: 'de', value: 'Alle ansehen' }),
      rec({ type: 'page', id: 'pg1', field: 'title', locale: 'de', value: 'Geschenk für Papa' }),
    ], OPTS);
    expect(plan.outcomes.map((o) => o.status)).toEqual(['set', 'set', 'set']);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].publish).toBe(true);
    const page = (plan.changes[0].after as Extract<EntityState, { kind: 'page' }>).page;
    expect(page.sections[0].translations[1]).toEqual({
      locale: 'de',
      content: { subheading: 'Finde deinen Favoriten', link_label: 'Alle ansehen', link_url: '/collections/pappa', collection_id: 'c1' },
    });
    expect(page.translations[1]).toEqual({ locale: 'de', title: 'Geschenk für Papa', meta_title: null, meta_description: null });
    const d = pageDiff((plan.changes[0].before as Extract<EntityState, { kind: 'page' }>).page, page);
    expect(d).toEqual({ translations: { changed: ['de'], removed: [] }, sections: [{ id: 'sec1', changed: ['de'], removed: [] }] });
  });

  it('writes a whole content object and warns when its keys differ from sv', () => {
    const plan = buildPlan(snapshot(), [
      rec({ type: 'page_section', id: 'sec1', field: 'content', locale: 'fr', value: { subheading: 'Trouvez', link_label: 'Voir tout' } }),
    ], OPTS);
    expect(plan.outcomes[0].status).toBe('set');
    expect(plan.warnings[0]).toMatch(/keys differ from sv/);
  });

  it('blocks a page whose draft differs from the published version', () => {
    const r = rec({ type: 'page', id: 'pg2', field: 'title', locale: 'de', value: 'Über namez' });
    const plan = buildPlan(snapshot(), [r], OPTS);
    expect(plan.outcomes[0].status).toBe('blocked');
    expect(plan.blocked_pages.pg2).toHaveLength(1);
    expect(buildPlan(snapshot(), [r], { ...OPTS, publishDraftChanges: true }).changes).toHaveLength(1);
  });

  it('writes option cards, stories, menus, designer labels, add-ons, theme and shipping names', () => {
    const plan = buildPlan(snapshot(), [
      rec({ type: 'option_card', id: 'p1', option: 'Välj storlek', value_key: 'Stor', field: 'badge', locale: 'de', value: 'Größter Wow-Effekt' }),
      rec({ type: 'option_card', id: 'p1', option: 'Välj storlek', value_key: 'Mellan', field: 'label', locale: 'de', value: 'Mittel' }),
      rec({ type: 'story', id: 's1', product_id: 'p1', field: 'quote', locale: 'de', value: 'So schön!' }),
      rec({ type: 'menu_item', id: 'i2', menu_id: 'm1', field: 'label_i18n', locale: 'de', value: 'Papa' }),
      rec({ type: 'designer_element', id: 'v1', template_id: 't1', field: 'elements.el1.label', locale: 'de', value: 'Name' }),
      rec({ type: 'designer_addon', id: 'p1', field: 'addons.double.label', locale: 'de', value: 'Doppelseitig' }),
      rec({ type: 'store_theme_translation', id: 'store-1', field: 'name', locale: 'sv', value: 'Namez – Personliga presenter' }),
      rec({ type: 'store_theme_translation', id: 'store-1', field: 'name', locale: 'de', value: 'Namez – Geschenke' }),
      rec({ type: 'shipping_method', id: 'sm1', field: 'translations', locale: 'de', value: 'Standardversand' }),
    ], OPTS);
    const status = Object.fromEntries(plan.outcomes.map((o) => [o.key, o.status]));
    expect(status['option_card|p1|Välj storlek|Stor|badge|de']).toBe('set');
    expect(status['option_card|p1|Välj storlek|Mellan|label|de']).toBe('error');
    expect(status['store_theme_translation|store-1|||name|sv']).toBe('conflict');
    const kinds = plan.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(['designer_addons', 'designer_template', 'menu', 'product_options', 'product_stories', 'shipping_method', 'store_theme']);
    const byKind = Object.fromEntries(plan.changes.map((c) => [c.kind, c.after])) as Record<string, any>;
    expect(byKind.product_options.variant_option_config[0].valueMeta.Stor).toEqual({ label: 'Stor', badge: 'Störst', i18n: { de: { badge: 'Größter Wow-Effekt' } } });
    expect(byKind.product_stories.stories[0].translations).toEqual([
      { locale: 'sv', quote: 'Så fin!', subtitle: null },
      { locale: 'de', quote: 'So schön!', subtitle: null },
    ]);
    expect(byKind.menu.items[0].children[0].label_i18n).toEqual({ sv: 'Pappa', de: 'Papa' });
    expect(byKind.designer_template.spec.surfaces[0].elements[0].label).toEqual({ sv: 'Namn', de: 'Name' });
    expect(byKind.designer_addons.addons.items[0].label).toEqual({ sv: 'Dubbelsidig', en: 'Double-sided', de: 'Doppelseitig' });
    expect(byKind.store_theme.theme_config).toEqual({ seo: { metaTitle: 'x' }, translations: { sv: { name: 'English text' }, de: { name: 'Namez – Geschenke' } } });
    expect(byKind.shipping_method.translations).toEqual({ sv: 'Standardfrakt', en: 'Standard shipping', de: 'Standardversand' });
  });

  it('merges option_labels per key and reports a differing key as a conflict', () => {
    const add = buildPlan(snapshot(), [
      rec({ type: 'custom_field', id: 'f1', product_id: 'p1', field: 'option_labels', locale: 'en', value: { B: 'Beta' } }),
    ], OPTS);
    expect(add.outcomes[0].status).toBe('set');
    const row = (add.changes[0].after as Extract<EntityState, { kind: 'custom_field' }>).translations[1];
    expect(row.option_labels).toEqual({ A: 'Alpha', B: 'Beta' });
    const clash = buildPlan(snapshot(), [
      rec({ type: 'custom_field', id: 'f1', product_id: 'p1', field: 'option_labels', locale: 'en', value: { A: 'Other' } }),
    ], OPTS);
    expect(clash.outcomes[0].status).toBe('conflict');
    expect(clash.changes).toHaveLength(0);
  });

  it('reports records whose target is missing', () => {
    const plan = buildPlan(snapshot(), [
      rec({ type: 'page_section', id: 'nope', field: 'html', locale: 'de', value: '<p>x</p>' }),
      rec({ type: 'collection', id: 'other-store', field: 'name', locale: 'de', value: 'X' }),
    ], OPTS);
    expect(plan.outcomes.map((o) => o.status)).toEqual(['error', 'error']);
  });

  it('honours --only-types', () => {
    const plan = buildPlan(snapshot(), [
      rec({ type: 'collection', id: 'c1', field: 'name', locale: 'de', value: 'Schmuck' }),
      rec({ type: 'faq', id: 'x', field: 'question', locale: 'de', value: 'F?' }),
    ], { ...OPTS, onlyTypes: ['collection'] });
    expect(plan.outcomes).toHaveLength(1);
    expect(plan.changes[0].kind).toBe('collection');
  });

  it('is idempotent: planning on the written state plans nothing', () => {
    const records = [
      rec({ type: 'collection', id: 'c1', field: 'name', locale: 'de', value: 'Schmuck' }),
      rec({ type: 'page_section', id: 'sec1', field: 'subheading', locale: 'fr', value: 'Trouvez votre favori' }),
      rec({ type: 'menu_item', id: 'i1', field: 'label_i18n', locale: 'fr', value: 'Pour lui' }),
    ];
    const first = buildPlan(snapshot(), records, OPTS);
    expect(first.changes).toHaveLength(3);
    const written = snapshot();
    for (const c of first.changes) {
      const a = c.after as any;
      if (c.kind === 'collection') written.collections.c1.translations = a.translations;
      if (c.kind === 'page') written.pages.pg1 = { ...written.pages.pg1, ...a.page };
      if (c.kind === 'menu') written.menus.m1.items = a.items;
    }
    const second = buildPlan(written, records, OPTS);
    expect(isNoop(second)).toBe(true);
    expect(second.outcomes.every((o) => o.status === 'unchanged')).toBe(true);
  });

  it('gives a stable fingerprint independent of jsonb key order', () => {
    const r = [rec({ type: 'collection', id: 'c1', field: 'name', locale: 'de', value: 'Schmuck' })];
    const a = snapshot();
    const b = snapshot();
    b.collections.c1.translations = [{ meta_desc: null, meta_title: null, long_description: null, description: null, name: 'Smycken', locale: 'sv' }];
    expect(fingerprint(buildPlan(a, r, OPTS))).toBe(fingerprint(buildPlan(b, r, OPTS)));
  });
});

describe('buildRestorePlan', () => {
  function backupOf(): { backup: BackupFile; after: EntityState } {
    const plan = buildPlan(snapshot(), [rec({ type: 'collection', id: 'c1', field: 'name', locale: 'de', value: 'Schmuck' })], OPTS);
    const c = plan.changes[0];
    return {
      after: c.after,
      backup: {
        format: 'namez-shop-i18n-backup/1',
        store: plan.store,
        created_at: '2026-11-20T00:00:00Z',
        fingerprint: fingerprint(plan),
        options: OPTS,
        entities: [{ kind: c.kind, id: c.id, before: c.before, after: c.after }],
        applied: ['collection:c1'],
      },
    };
  }
  it('restores an entity that is at its after state', () => {
    const { backup, after } = backupOf();
    const plan = buildRestorePlan(backup, () => after, false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].after).toEqual(backup.entities[0].before);
  });
  it('skips an entity edited after the apply unless forced, and one already restored', () => {
    const { backup, after } = backupOf();
    const edited = JSON.parse(JSON.stringify(after));
    edited.translations[1].name = 'Owner edit';
    expect(buildRestorePlan(backup, () => edited, false).drifted).toEqual(['collection:c1']);
    expect(buildRestorePlan(backup, () => edited, true).changes).toHaveLength(1);
    const restored = stateFromSnapshot(snapshot(), 'collection', 'c1');
    expect(buildRestorePlan(backup, () => restored, false).unchanged).toEqual(['collection:c1']);
  });
});

describe('draftDiff', () => {
  const live = {
    page: { slug: 'a', seo: {}, translations: [{ id: 'x', page_id: 'p', locale: 'sv', title: 'A' }] },
    sections: [{ id: 's', section_key: 'rich-text', settings: {}, sort_order: 0, translations: [{ locale: 'sv', content: { html: '<p>a</p>', b: 1 } }] }],
  };
  it('ignores row ids and key order', () => {
    const draft = {
      page: { slug: 'a', seo: {}, translations: [{ id: 'y', locale: 'sv', title: 'A' }] },
      sections: [{ id: 's', section_key: 'rich-text', settings: {}, sort_order: 0, translations: [{ locale: 'sv', content: { b: 1, html: '<p>a</p>' } }] }],
    };
    expect(draftDiff(draft, live)).toEqual([]);
  });
  it('lists changed and hidden sections', () => {
    const draft = { page: live.page, sections: [] };
    expect(draftDiff(draft, live)).toEqual(['section rich-text s is published but hidden or deleted in the draft']);
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run and requires --store and --file', () => {
    expect(parseArgs(['--file=t.json', '--store', 'namez-se'])).toMatchObject({ mode: 'dry-run', file: 't.json', store: 'namez-se', overwrite: false });
    expect(() => parseArgs(['--file=t.json'])).toThrow('--store');
    expect(() => parseArgs(['--store=x'])).toThrow('--file');
  });
  it('parses apply, overwrite, only-types and merge', () => {
    expect(
      parseArgs(['--file=t.json', '--store=s', '--apply', '--fingerprint=abc', '--overwrite', '--only-types=page_translation,faq', '--backup-dir=/tmp/b']),
    ).toMatchObject({ mode: 'apply', fingerprint: 'abc', overwrite: true, onlyTypes: ['page', 'faq'], backupDir: '/tmp/b' });
    expect(parseArgs(['--merge=a.json,b.json', '--out=t.json'])).toMatchObject({ merge: ['a.json', 'b.json'], out: 't.json' });
    expect(() => parseArgs(['--merge=a.json'])).toThrow('--out');
    expect(() => parseArgs(['--file=t', '--store=s', '--only-types=nope'])).toThrow('unknown nope');
    expect(() => parseArgs(['--file=t', '--store=s', '--apply', '--snapshot=x'])).toThrow('offline');
  });
});
