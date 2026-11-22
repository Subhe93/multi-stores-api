import {
  buildPlan,
  buildRestorePlan,
  fingerprint,
  parseArgs,
  planBlocked,
  validateLabelsFile,
  writesByProduct,
  type BackupFile,
  type LabelsFile,
  type PlanOptions,
  type Snapshot,
} from './namez-option-labels-apply.planner';

// M159 Namez option labels: pure plan / restore logic.

const OPTS: PlanOptions = {
  locales: ['de', 'en'],
  overwrite: false,
  allowMissing: false,
};

const FILE: LabelsFile = {
  meta: { store: 'namez-se', locales: ['de', 'en'] },
  names: {
    Färg: { de: 'Farbe', en: 'Colour' },
    Djur: { de: 'Tier', en: 'Animal' },
  },
  values: {
    Färg: {
      Svart: { de: 'Schwarz', en: 'Black' },
      Orange: { de: 'Orange', en: 'Orange' },
    },
    Djur: {
      Zebra: { de: 'Zebra', en: 'Zebra' },
      Anka: { de: 'Ente', en: 'Duck' },
    },
  },
  overrides: { termos: { values: { Djur: { Anka: { en: 'Duckling' } } } } },
};

function snapshot(): Snapshot {
  return {
    store: { id: 'st1', slug: 'namez-se', primary_locale: 'sv' },
    products: [
      {
        id: 'p1',
        slug: 'mugg',
        options: { Färg: ['Svart', 'Orange'] },
        rows: { sv: null, de: null, en: null },
      },
      {
        id: 'p2',
        slug: 'termos',
        options: { Djur: ['Zebra', 'Anka'] },
        rows: { sv: null, de: null },
      },
      { id: 'p3', slug: 'plain', options: {}, rows: { sv: null } },
    ],
  };
}

describe('namez option labels planner', () => {
  it('plans labels per product and locale; equal-to-canonical is not stored', () => {
    const plan = buildPlan(snapshot(), FILE, OPTS);
    expect(plan.missing).toEqual([]);
    expect(plan.changes.map((c) => `${c.product_id}:${c.locale}`)).toEqual([
      'p1:de',
      'p1:en',
      'p2:de',
    ]);
    expect(plan.changes[0].after).toEqual({
      names: { Färg: 'Farbe' },
      values: { Färg: { Svart: 'Schwarz' } },
    });
    expect(plan.missingRow).toEqual([
      { product_id: 'p2', slug: 'termos', locale: 'en' },
    ]);
    expect(planBlocked(plan, OPTS)).toBe(false);
  });

  it('uses per-product overrides', () => {
    const snap = snapshot();
    snap.products[1].rows.en = null;
    const plan = buildPlan(snap, FILE, OPTS);
    const en = plan.changes.find(
      (c) => c.product_id === 'p2' && c.locale === 'en',
    )!;
    expect(en.after).toEqual({
      names: { Djur: 'Animal' },
      values: { Djur: { Anka: 'Duckling' } },
    });
  });

  it('a live value without a label fails the plan unless allowed', () => {
    const snap = snapshot();
    snap.products[0].options.Färg.push('Lila');
    const plan = buildPlan(snap, FILE, OPTS);
    expect(plan.missing).toEqual([
      {
        product_id: 'p1',
        slug: 'mugg',
        locale: 'de',
        path: 'values.Färg.Lila',
      },
      {
        product_id: 'p1',
        slug: 'mugg',
        locale: 'en',
        path: 'values.Färg.Lila',
      },
    ]);
    expect(planBlocked(plan, OPTS)).toBe(true);
    expect(planBlocked(plan, { allowMissing: true })).toBe(false);
  });

  it('a different stored label is a conflict, replaced only with --overwrite', () => {
    const snap = snapshot();
    snap.products[0].rows.de = { names: { Färg: 'Farbton' } };
    const plan = buildPlan(snap, FILE, OPTS);
    expect(plan.conflicts).toEqual([
      {
        product_id: 'p1',
        slug: 'mugg',
        locale: 'de',
        path: 'names.Färg',
        current: 'Farbton',
        wanted: 'Farbe',
      },
    ]);
    expect(
      plan.changes.find((c) => c.locale === 'de' && c.product_id === 'p1')!
        .after,
    ).toEqual({
      names: { Färg: 'Farbton' },
      values: { Färg: { Svart: 'Schwarz' } },
    });
    const over = buildPlan(snap, FILE, { ...OPTS, overwrite: true });
    expect(over.conflicts).toEqual([]);
    expect(
      over.changes.find((c) => c.locale === 'de' && c.product_id === 'p1')!
        .after!.names,
    ).toEqual({ Färg: 'Farbe' });
  });

  it('is idempotent: applying the plan leaves nothing to do', () => {
    const snap = snapshot();
    const plan = buildPlan(snap, FILE, OPTS);
    for (const c of plan.changes)
      snap.products.find((p) => p.id === c.product_id)!.rows[c.locale] =
        c.after;
    const again = buildPlan(snap, FILE, OPTS);
    expect(again.changes).toEqual([]);
    expect(again.unchanged).toBe(3);
  });

  it('skips the primary locale', () => {
    const plan = buildPlan(snapshot(), FILE, {
      ...OPTS,
      locales: ['sv', 'de'],
    });
    expect(plan.skippedPrimary).toBe(true);
    expect(plan.changes.every((c) => c.locale === 'de')).toBe(true);
  });

  it('fingerprint is stable and changes with the plan', () => {
    const a = fingerprint(buildPlan(snapshot(), FILE, OPTS));
    expect(fingerprint(buildPlan(snapshot(), FILE, OPTS))).toBe(a);
    expect(
      fingerprint(buildPlan(snapshot(), FILE, { ...OPTS, locales: ['de'] })),
    ).not.toBe(a);
  });

  it('groups writes per product', () => {
    const w = writesByProduct(buildPlan(snapshot(), FILE, OPTS).changes);
    expect([...w.keys()]).toEqual(['p1', 'p2']);
    expect(Object.keys(w.get('p1')!)).toEqual(['de', 'en']);
  });

  it('restore puts `before` back, skips drifted rows unless forced', () => {
    const snap = snapshot();
    const plan = buildPlan(snap, FILE, OPTS);
    for (const c of plan.changes)
      snap.products.find((p) => p.id === c.product_id)!.rows[c.locale] =
        c.after;
    const backup: BackupFile = {
      format: 'namez-option-labels-backup/1',
      store: { id: 'st1', slug: 'namez-se' },
      created_at: 'x',
      fingerprint: fingerprint(plan),
      entities: plan.changes,
      applied: [],
    };
    snap.products[0].rows.en = { names: { Färg: 'Color' } };
    const r = buildRestorePlan(backup, snap, false);
    expect(
      r.changes.map(
        (c) =>
          `${c.product_id}:${c.locale}:${c.after === null ? 'null' : 'labels'}`,
      ),
    ).toEqual(['p1:de:null', 'p2:de:null']);
    expect(r.drifted).toEqual([{ product_id: 'p1', locale: 'en' }]);
    expect(buildRestorePlan(backup, snap, true).changes).toHaveLength(3);
  });

  it('validates the file shape and the arguments', () => {
    expect(validateLabelsFile(FILE)).toEqual([]);
    expect(
      validateLabelsFile({ names: { Färg: { de: '' } }, values: {} }),
    ).toEqual(['file.names.Färg.de: not a non-empty string']);
    expect(
      parseArgs([
        '--file=x.json',
        '--store=namez-se',
        '--apply',
        '--fingerprint',
        'abc',
        '--locales=de,en',
      ]),
    ).toMatchObject({
      mode: 'apply',
      fingerprint: 'abc',
      locales: ['de', 'en'],
    });
    expect(() => parseArgs(['--file=x.json'])).toThrow('--store');
    expect(() => parseArgs(['--store=s', '--bogus'])).toThrow('Unknown option');
  });
});
