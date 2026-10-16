import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluatePersonalization,
  formatMinorUnits,
  insertAtCaret,
  lineSnapshotColumns,
  splitFieldTree,
  toMinorUnits,
  truncateChars,
} from './evaluator';
import { evaluateConditions, optionCount } from './conditions';
import {
  buildPersonalizationGroups,
  groupValueText,
  hasPersonalizationGroups,
  snapshotGroupLabel,
} from './display';
import { APP_ONLY_TYPES, type PContext, type PFieldDef } from './types';
import { lineKey, validatePersonalization, type FieldDef } from './rules';

// Runs every M4.1 evaluator case (personalization-cases.json) against the api
// mirror, proves the M4.0 parity on every M4.0 validate vector, and checks
// that the mirror is still a byte copy of the shared source when the shared
// repo is checked out next to this one (contract C12).

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
type Json = any;

const MIRRORED = ['types.ts', 'conditions.ts', 'evaluator.ts', 'display.ts'];
const CASES_PATH = join(__dirname, 'personalization-cases.json');
const cases: Record<string, Json> = JSON.parse(
  readFileSync(CASES_PATH, 'utf8'),
);
const m40: Record<string, Json> = JSON.parse(
  readFileSync(join(__dirname, 'personalization.vectors.json'), 'utf8'),
);

const SHARED_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'multi-stores-shared',
  'src',
  'personalization',
);

const lf = (path: string): string =>
  readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');
const mirrorBody = (file: string): string =>
  lf(join(__dirname, file)).split('\n').slice(3).join('\n');

const defsOf = (c: Json): PFieldDef[] =>
  typeof c.defs === 'string' ? cases.defs[c.defs] : c.defs;
const ctxOf = (c: Json): PContext => ({ ...cases.baseContext, ...c.ctx });
const withoutMessage = (errors: Json[]): Json[] =>
  errors.map(({ message, ...rest }) => {
    expect(message).toBe('');
    return rest;
  });

describe('personalization evaluator mirror parity', () => {
  const sharedAvailable = existsSync(join(SHARED_DIR, 'evaluator.ts'));

  it.each(MIRRORED)('%s carries the mirror header', (file) => {
    const head = lf(join(__dirname, file)).split('\n').slice(0, 3);
    expect(head[0]).toBe('/* eslint-disable */');
    expect(head[1]).toContain('MIRROR');
    expect(head[1]).toContain(
      `multi-stores-shared/src/personalization/${file}`,
    );
  });

  (sharedAvailable ? it.each(MIRRORED) : it.skip.each(MIRRORED))(
    '%s body equals the shared source (sha256)',
    (file) => {
      expect(sha256(mirrorBody(file))).toBe(sha256(lf(join(SHARED_DIR, file))));
    },
  );

  (sharedAvailable ? it : it.skip)(
    'cases are a byte copy of the shared file (sha256)',
    () => {
      expect(sha256(lf(CASES_PATH))).toBe(
        sha256(lf(join(SHARED_DIR, 'personalization-cases.json'))),
      );
    },
  );

  it('has the price-guard cases', () => {
    expect((cases.evaluateGuards as Json[]).length).toBeGreaterThanOrEqual(8);
  });

  it('runs all 174 cases', () => {
    const count = [
      'evaluate',
      'conditions',
      'optionCount',
      'money',
      'formatMoney',
      'truncate',
      'insertAtCaret',
      'display',
      'groupLabels',
    ].reduce((n, k) => n + (cases[k] as Json[]).length, 0);
    expect(cases.version).toBe(1);
    expect(count).toBe(174);
  });
});

describe('evaluatePersonalization cases', () => {
  // `evaluateGuards`: the price-guard cases (same format; not in the 174 count).
  it.each(
    [...cases.evaluate, ...(cases.evaluateGuards ?? [])].map((c: Json) => [
      c.name,
      c,
    ]),
  )('%s', (_n, c: Json) => {
    const defs = defsOf(c);
    const ctx = ctxOf(c);
    const res = evaluatePersonalization(defs, c.raw, ctx);
    const e = c.expect;

    if (e.ok !== undefined) expect(res.ok).toBe(e.ok);
    if (e.legacy !== undefined) expect(res.legacy).toBe(e.legacy);
    if (e.errors !== undefined) expect(res.errors).toEqual(e.errors);
    if (e.errorCount !== undefined)
      expect(res.errors).toHaveLength(e.errorCount);
    if (e.lastError !== undefined) {
      expect(res.errors[res.errors.length - 1]).toEqual(e.lastError);
    }
    if (e.values !== undefined) expect(res.values).toEqual(e.values);
    if (e.priceDelta !== undefined) expect(res.priceDelta).toBe(e.priceDelta);
    if (e.priceDeltaMinor !== undefined) {
      expect(res.priceDeltaMinor).toBe(e.priceDeltaMinor);
    }
    if (e.visibleIds !== undefined)
      expect(res.visibleIds).toEqual(e.visibleIds);
    if (e.lineCount !== undefined) expect(res.lines).toHaveLength(e.lineCount);
    if (e.lines !== undefined) {
      expect(res.lines).toHaveLength(e.lines.length);
      e.lines.forEach((l: Json, i: number) =>
        expect(res.lines[i]).toMatchObject(l),
      );
    }
    if (e.snapshot !== undefined) {
      e.snapshot.forEach((s: Json, i: number) =>
        expect(lineSnapshotColumns(res.lines[i])).toEqual(s),
      );
    }

    // Invariants: the total is the sum of the lines, as text and in minor units.
    const sum = res.lines.reduce((n, l) => n + l.price_delta_minor, 0);
    expect(res.priceDeltaMinor).toBe(sum);
    expect(res.priceDelta).toBe(formatMinorUnits(sum));
    for (const l of res.lines)
      expect(l.price_delta).toBe(formatMinorUnits(l.price_delta_minor));

    if (!res.legacy) {
      // Canonical values are stable: evaluating them again changes nothing.
      const again = evaluatePersonalization(defs, res.values, ctx);
      expect(JSON.stringify(again.values)).toBe(JSON.stringify(res.values));
      expect(again.priceDeltaMinor).toBe(res.priceDeltaMinor);
      expect(lineKey(again.values)).toBe(lineKey(res.values));
    }

    if (c.compareToM40) {
      const fields = splitFieldTree(defs).top.filter(
        (d) => !APP_ONLY_TYPES.has(d.type),
      );
      const m = validatePersonalization({
        fields: fields as FieldDef[],
        values: c.raw,
      });
      expect(res.ok).toBe(m.ok);
      expect(withoutMessage(res.errors)).toEqual(m.issues);
      expect(res.values).toEqual(m.values);
    }
    if (c.sameAs !== undefined) {
      const b = evaluatePersonalization(defs, c.sameAs, ctx);
      expect(JSON.stringify(res.values)).toBe(JSON.stringify(b.values));
      expect(lineKey(res.values)).toBe(lineKey(b.values));
    }
    if (c.differentFrom !== undefined) {
      const b = evaluatePersonalization(defs, c.differentFrom, ctx);
      expect(lineKey(res.values)).not.toBe(lineKey(b.values));
    }
  });
});

describe('M4.0 parity on every M4.0 validate vector', () => {
  const base = cases.baseContext;
  // Vectors whose fields use an app-only type (M4.0 passed them through as
  // "unknown") are M4.1 fields: D10 drops them in the legacy branch (below).
  const usesAppType = (v: Json): boolean =>
    (v.fields as Json[]).some((f) => APP_ONLY_TYPES.has(f.type));
  const vectors: Json[] = m40.validate.filter((v: Json) => !usesAppType(v));

  it.each(vectors.map((v: Json) => [v.name, v]))(
    'app off: %s',
    (_n, v: Json) => {
      const m = validatePersonalization({
        fields: v.fields,
        values: v.values,
        prefilled: v.prefilled,
      });
      const res = evaluatePersonalization(v.fields, v.values, {
        ...base,
        appEnabled: false,
        prefilled: v.prefilled,
      });
      expect(res.legacy).toBe(true);
      expect(res.ok).toBe(m.ok);
      expect(withoutMessage(res.errors)).toEqual(m.issues);
      expect(res.values).toEqual(m.values);
      expect(res.priceDelta).toBe('0.00');
    },
  );

  // App on: fields without M4.1 features evaluate exactly as M4.0 (prefilled
  // values only exist on custom products, which always take the legacy branch).
  const appOn = vectors.filter((v: Json) => !v.prefilled);
  it.each(appOn.map((v: Json) => [v.name, v]))('app on: %s', (_n, v: Json) => {
    const m = validatePersonalization({ fields: v.fields, values: v.values });
    const res = evaluatePersonalization(v.fields, v.values, {
      ...base,
      appEnabled: true,
    });
    expect(res.legacy).toBe(false);
    expect(res.ok).toBe(m.ok);
    expect(withoutMessage(res.errors)).toEqual(m.issues);
    expect(res.values).toEqual(m.values);
    expect(res.priceDelta).toBe('0.00');
  });

  it('covers every M4.0 validate vector', () => {
    expect(vectors.length + m40.validate.filter(usesAppType).length).toBe(
      m40.validate.length,
    );
    expect(vectors.length).toBeGreaterThan(0);
    expect(appOn.length).toBeGreaterThan(0);
  });

  it.each(m40.validate.filter(usesAppType).map((v: Json) => [v.name, v]))(
    'app off drops app-only types (D10): %s',
    (_n, v: Json) => {
      const res = evaluatePersonalization(v.fields, v.values, {
        ...base,
        appEnabled: false,
      });
      const appIds = (v.fields as Json[])
        .filter((f) => APP_ONLY_TYPES.has(f.type))
        .map((f) => f.id);
      for (const id of appIds) expect(res.values).not.toHaveProperty(id);
      expect(res.visibleIds.some((id) => appIds.includes(id))).toBe(false);
    },
  );
});

describe('conditions cases', () => {
  it.each(cases.conditions.map((c: Json) => [c.name, c]))(
    '%s',
    (_n, c: Json) => {
      const ctx = {
        variantOptions: c.options ?? {},
        optionConfig: c.optionConfig ?? [],
      };
      const fields: Record<string, unknown> = c.fields ?? {};
      expect(
        evaluateConditions(c.conditions, ctx, (name) => fields[name]),
      ).toBe(c.expected);
    },
  );
});

describe('optionCount cases', () => {
  it.each(cases.optionCount.map((c: Json) => [c.name, c]))(
    '%s',
    (_n, c: Json) => {
      const ctx = {
        variantOptions: c.options ?? {},
        optionConfig: c.optionConfig ?? [],
      };
      expect(optionCount(ctx, c.count)).toBe(c.expected);
    },
  );
});

describe('money cases', () => {
  it.each(cases.money.map((c: Json) => [JSON.stringify(c.input), c]))(
    'toMinorUnits(%s)',
    (_n, c: Json) => {
      expect(toMinorUnits(c.input)).toBe(c.minor);
    },
  );
  it.each(cases.formatMoney.map((c: Json) => [c.minor, c]))(
    'formatMinorUnits(%s)',
    (_n, c: Json) => {
      expect(formatMinorUnits(c.minor)).toBe(c.text);
    },
  );
});

describe('character helper cases', () => {
  it.each(cases.truncate.map((c: Json) => [JSON.stringify(c.input), c]))(
    'truncateChars(%s)',
    (_n, c: Json) => {
      expect(truncateChars(c.input, c.max)).toBe(c.expected);
    },
  );
  it.each(cases.insertAtCaret.map((c: Json) => [c.name, c]))(
    '%s',
    (_n, c: Json) => {
      expect(insertAtCaret(c.value, c.caret, c.ch, c.max)).toEqual(c.expected);
    },
  );
});

describe('display cases', () => {
  it.each(cases.display.map((c: Json) => [c.name, c]))('%s', (_n, c: Json) => {
    const out = buildPersonalizationGroups(c.rows, {
      ...(c.opts ?? {}),
      ...(c.useDefaultLabel
        ? { defaultGroupLabel: (i: number) => `Item ${i}` }
        : {}),
    });
    expect(out).toEqual(c.expected);
    expect(hasPersonalizationGroups(c.rows)).toBe(c.expected.groups.length > 0);
    if (c.groupText)
      expect(out.groups.map((g) => groupValueText(g))).toEqual(c.groupText);
  });
  it.each(cases.groupLabels.map((c: Json) => [c.name, c]))(
    'snapshotGroupLabel: %s',
    (_n, c: Json) => {
      expect(snapshotGroupLabel(c.row, c.locale, c.primary)).toBe(c.expected);
    },
  );
});
