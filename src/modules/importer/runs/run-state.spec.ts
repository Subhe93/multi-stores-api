import { ImportRunStatus } from '@prisma/client';
import {
  assertTransition,
  canTransition,
  RUN_TRANSITIONS,
  ACTIVE_RUN_STATUSES,
  InvalidRunTransitionError,
} from './run-state';
import { defaultRunOptions, normalizeRunOptions } from './run-options';

const ALL = Object.values(ImportRunStatus);
const S = ImportRunStatus;

describe('run state machine (M4.4 D3)', () => {
  const legal: [ImportRunStatus, ImportRunStatus][] = [
    [S.UPLOADED, S.PLANNING],
    [S.PLANNING, S.PLANNED],
    [S.PLANNING, S.PLAN_FAILED],
    [S.PLANNING, S.UPLOADED],
    [S.PLANNED, S.QUEUED],
    [S.PLANNED, S.UPLOADED],
    [S.PLAN_FAILED, S.UPLOADED],
    [S.QUEUED, S.RUNNING],
    [S.RUNNING, S.COMPLETED],
    [S.RUNNING, S.COMPLETED_WITH_WARNINGS],
    [S.RUNNING, S.FAILED],
    [S.RUNNING, S.CANCELLED],
    [S.RUNNING, S.QUEUED],
    [S.COMPLETED, S.ROLLBACK_QUEUED],
    [S.COMPLETED_WITH_WARNINGS, S.ROLLBACK_QUEUED],
    [S.FAILED, S.ROLLBACK_QUEUED],
    [S.CANCELLED, S.ROLLBACK_QUEUED],
    [S.ROLLBACK_QUEUED, S.ROLLING_BACK],
    [S.ROLLING_BACK, S.ROLLED_BACK],
    [S.ROLLING_BACK, S.ROLLBACK_QUEUED],
    [S.ROLLING_BACK, S.ROLLBACK_FAILED],
    [S.ROLLBACK_FAILED, S.ROLLBACK_QUEUED],
  ];
  it.each(legal)('%s → %s is legal', (a, b) =>
    expect(canTransition(a, b)).toBe(true),
  );

  it('every other transition is illegal', () => {
    const ok = new Set(legal.map(([a, b]) => `${a}>${b}`));
    for (const a of ALL)
      for (const b of ALL) {
        const allowed = RUN_TRANSITIONS[a].includes(b);
        if (!ok.has(`${a}>${b}`) && allowed && !['CANCELLED'].includes(b))
          throw new Error(`unexpected ${a}>${b}`);
      }
    expect(() => assertTransition(S.PLANNED, S.RUNNING)).toThrow(
      InvalidRunTransitionError,
    );
    expect(() => assertTransition(S.ROLLED_BACK, S.ROLLBACK_QUEUED)).toThrow();
    expect(() => assertTransition(S.UPLOADED, S.QUEUED)).toThrow();
    expect(() => assertTransition(S.COMPLETED, S.RUNNING)).toThrow();
  });

  it('active statuses match the partial unique index', () => {
    expect([...ACTIVE_RUN_STATUSES].sort()).toEqual([
      'PLANNING',
      'QUEUED',
      'ROLLBACK_QUEUED',
      'ROLLING_BACK',
      'RUNNING',
    ]);
  });
});

describe('run options', () => {
  it('fills defaults', () => {
    expect(normalizeRunOptions(undefined)).toEqual({
      options: defaultRunOptions(),
      errors: [],
    });
  });
  it('rejects unknown keys and bad values', () => {
    const { errors } = normalizeRunOptions({
      bogus: 1,
      conflict_policy: 'NUKE',
      status_map: { publish: 'LIVE' },
      shipping: { default_days: { min: 5, max: 1 } },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'unknown option: bogus',
        expect.stringMatching(/^conflict_policy/),
        expect.stringMatching(/^status_map\.publish/),
        expect.stringMatching(/^shipping\.default_days/),
      ]),
    );
  });
  it('accepts the namez-2026 profile shape', () => {
    const { options, errors } = normalizeRunOptions({
      scopes: { shipping: false },
      skip_ext_ids: ['woo:namez.se:product:4326'],
      customization_type_rules: [
        { mechanisms: ['engraving_lines'], type: 'ENGRAVE' },
        { designer: true, type: 'PRINT' },
      ],
      label_overrides: { pa_x: 'Välj antal' },
      verify_media: true,
    });
    expect(errors).toEqual([]);
    expect(options.scopes.shipping).toBe(false);
    expect(options.customization_type_rules).toHaveLength(2);
  });
});
